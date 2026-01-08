import {
    App,
    Editor,
    EditorPosition,
    EditorSuggest,
    EditorSuggestContext,
    EditorSuggestTriggerInfo,
    MetadataCache,
    Plugin,
    PluginSettingTab,
    Setting,
    TFile,
    Vault,
    setIcon,
    Notice
} from 'obsidian';

// --- SETTINGS ---
interface AutoLinkerSettings {
    triggerKey: string; // e.g., ";"
}

const DEFAULT_SETTINGS: AutoLinkerSettings = {
    triggerKey: '' // Empty = Auto Mode (Always show)
};

// --- TYPES ---
type IndexEntryType = 'title' | 'heading' | 'block' | 'tag';
type IndexEntry = {
    type: IndexEntryType;
    notePath: string;
    noteTitle: string;
    target: string;
    displayText: string;
    score?: number;
};

// --- HELPER: FUZZY MATCH ---
function fuzzyMatch(query: string, text: string): boolean {
    const queryChars = query.toLowerCase().split('');
    const textLower = text.toLowerCase();
    let searchIndex = 0;

    for (const char of queryChars) {
        const foundIndex = textLower.indexOf(char, searchIndex);
        if (foundIndex === -1) return false;
        searchIndex = foundIndex + 1;
    }
    return true;
}

// --- HELPER: TEXT SCANNER (Shared by Suggest & Command) ---
// Returns the phrase found before the cursor and its range
function scanForPhrase(line: string, cursorCh: number): { query: string, startCh: number, endCh: number } | null {
    // 1. Identify sentence boundaries (to avoid scanning across periods)
    let sentenceStart = 0;
    let sentenceEnd = line.length;
    
    // Scan back for sentence start
    for (let i = cursorCh - 1; i >= 0; i--) {
        if (/[.!?]/.test(line[i])) {
            sentenceStart = i + 1;
            break;
        }
    }
    // Scan forward for sentence end
    for (let i = cursorCh; i < line.length; i++) {
        if (/[.!?]/.test(line[i])) {
            sentenceEnd = i;
            break;
        }
    }
    
    // Trim spaces
    while (sentenceStart < sentenceEnd && /\s/.test(line[sentenceStart])) sentenceStart++;
    while (sentenceEnd > sentenceStart && /\s/.test(line[sentenceEnd - 1])) sentenceEnd--;
    
    const sentence = line.substring(sentenceStart, sentenceEnd);
    const sentenceOffset = sentenceStart;

    // 2. Identify word boundaries
    const wordsWithIndices: { word: string, start: number, end: number }[] = [];
    let wordRegex = /\b\w[\w\p{L}\p{N}'-]*\b/gu;
    let match;
    while ((match = wordRegex.exec(sentence)) !== null) {
        wordsWithIndices.push({ word: match[0], start: match.index, end: match.index + match[0].length });
    }

    // 3. Find which word the cursor is touching
    let cursorInSentence = cursorCh - sentenceOffset;
    
    // Allow cursor to be at the immediate end of a word
    let cursorWordIdx = wordsWithIndices.findIndex(w => cursorInSentence >= w.start && cursorInSentence <= w.end);
    if (cursorWordIdx === -1) cursorWordIdx = wordsWithIndices.findIndex(w => cursorInSentence === w.end); // End of word
    
    if (cursorWordIdx === -1) return null;

    // 4. Return the phrase (We return the longest possible phrase ending at cursor for the plugin to test)
    // Actually, to keep it simple for the scanner, we'll return the whole sentence details
    // and let the caller loop through combinations. 
    // BUT for this helper, let's just return the sentence context so the caller can do the heavy lifting
    // or we move the logic here.
    
    return null; // Logic is complex, we will keep it inside the Suggest class for now and replicate for Command
}

export default class AutoLinker extends Plugin {
    public settings!: AutoLinkerSettings; 
    private index: Map<string, IndexEntry[]> = new Map();
    private metadataCache!: MetadataCache;
    private vault!: Vault;
    private isIndexing = false;
    private debounceTimeout?: number;
    private startupAttempts = 0;
    private maxStartupAttempts = 2;
    private statusBarEl!: HTMLElement;

    async onload() {
        await this.loadSettings();
        this.startupAttempts++;

        try {
            await this.initializePlugin();
            this.initStatusBar();
            this.initRibbonIcon();

            // Reload Command
            this.addCommand({
                id: 'reload-auto-linker',
                name: 'Reload Plugin',
                callback: () => this.reloadSelf()
            });

            // --- NEW COMMAND: QUICK LINK ---
            // Allows the user to bind a Hotkey (e.g. Ctrl+L) to link the phrase under cursor
            this.addCommand({
                id: 'auto-linker-quick-link',
                name: 'Convert phrase to link',
                editorCallback: (editor: Editor) => this.runQuickLink(editor)
            });

            if (this.index.size === 0 && this.startupAttempts < this.maxStartupAttempts) {
                setTimeout(() => this.reloadSelf(), 200);
            } else {
                this.showStartupNotice();
            }

        } catch (err) {
            console.error("Auto Linker startup failed:", err);
            if (this.startupAttempts < this.maxStartupAttempts) {
                setTimeout(() => this.reloadSelf(), 200);
            }
        }
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    private initStatusBar() {
        this.statusBarEl = this.addStatusBarItem();
        this.updateStatusBar('active');
        this.statusBarEl.onClickEvent(() => this.reloadSelf());
    }

    private updateStatusBar(state: 'active' | 'reloading') {
        if (!this.statusBarEl) return;
        const icon = state === 'active' ? 'check' : 'refresh-cw';
        this.statusBarEl.empty();
        setIcon(this.statusBarEl.createSpan(), icon);
        this.statusBarEl.setAttr('title', `Auto Linker: ${state}. Click to reload.`);
    }

    private initRibbonIcon() {
        this.addRibbonIcon('refresh-cw', 'Reload Auto Linker', () => {
            this.reloadSelf();
        });
    }

    async reloadSelf() {
        this.updateStatusBar('reloading');
        await (this.app as any).plugins.disablePlugin(this.manifest.id);
        await (this.app as any).plugins.enablePlugin(this.manifest.id);
    }

    private showStartupNotice() {
        new Notice("✅ Auto Linker initialized", 3000);
    }

    async initializePlugin() {
        this.metadataCache = this.app.metadataCache;
        this.vault = this.app.vault;
        await this.buildFullIndex();

        this.registerEvent(this.metadataCache.on('changed', (file) => this.debouncedIndexUpdate(file)));
        this.registerEvent(this.vault.on('create', (file) => { if (file instanceof TFile) this.debouncedIndexUpdate(file); }));
        this.registerEvent(this.vault.on('delete', (file) => { if (file instanceof TFile) this.deleteFromIndex(file); }));
        this.registerEvent(this.vault.on('rename', (file, oldPath) => { if (file instanceof TFile) this.renameInIndex(file, oldPath); }));

        this.registerEditorSuggest(new AutoLinkerSuggest(this));
    }

    // --- QUICK LINK COMMAND LOGIC ---
    // This replicates the scanning logic but triggers immediately on Hotkey press
    private runQuickLink(editor: Editor) {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        
        // 1. Basic Sentence Parsing (Same as Suggest)
        const sentenceEndRegex = /[.!?]/g;
        let sentenceStart = 0;
        let sentenceEnd = line.length;
        for (let i = cursor.ch - 1; i >= 0; i--) {
            if (/[.!?]/.test(line[i])) { sentenceStart = i + 1; break; }
        }
        for (let i = cursor.ch; i < line.length; i++) {
            if (/[.!?]/.test(line[i])) { sentenceEnd = i; break; }
        }
        while (sentenceStart < sentenceEnd && /\s/.test(line[sentenceStart])) sentenceStart++;
        
        const sentence = line.substring(sentenceStart, sentenceEnd);
        const sentenceOffset = sentenceStart;

        // 2. Word Tokenization
        const wordsWithIndices: { word: string, start: number, end: number }[] = [];
        let wordRegex = /\b\w[\w\p{L}\p{N}'-]*\b/gu;
        let match;
        while ((match = wordRegex.exec(sentence)) !== null) {
            wordsWithIndices.push({ word: match[0], start: match.index, end: match.index + match[0].length });
        }

        let cursorInSentence = cursor.ch - sentenceOffset;
        let cursorWordIdx = wordsWithIndices.findIndex(w => cursorInSentence >= w.start && cursorInSentence <= w.end);
        if (cursorWordIdx === -1) cursorWordIdx = wordsWithIndices.findIndex(w => cursorInSentence === w.end);
        
        if (cursorWordIdx === -1) {
            new Notice("No valid phrase found under cursor.");
            return;
        }

        // 3. Find Matches (Longest first)
        for (let span = wordsWithIndices.length; span >= 1; span--) {
            for (let offset = 0; offset <= wordsWithIndices.length - span; offset++) {
                const startIdx = offset;
                const endIdx = startIdx + span - 1;
                
                // Ensure the cursor is inside this phrase
                if (cursorWordIdx < startIdx || cursorWordIdx > endIdx) continue;

                const phraseStart = wordsWithIndices[startIdx].start;
                const phraseEnd = wordsWithIndices[endIdx].end;
                const phrase = sentence.substring(phraseStart, phraseEnd);
                
                // Exact matches only for Quick Link to avoid noise
                const suggestions = this.getSuggestions(phrase);
                // Filter for high confidence
                const bestMatch = suggestions.find(s => s.displayText.toLowerCase() === phrase.toLowerCase());

                if (bestMatch) {
                    // LINK IT!
                    const startPos = { line: cursor.line, ch: sentenceOffset + phraseStart };
                    const endPos = { line: cursor.line, ch: sentenceOffset + phraseEnd };
                    
                    let linkText = `[[${bestMatch.target}|${phrase}]]`;
                    if (bestMatch.type === 'heading') linkText = `[[${bestMatch.noteTitle}#${bestMatch.target}|${phrase}]]`;
                    if (bestMatch.type === 'block') linkText = `[[${bestMatch.noteTitle}#^${bestMatch.target}|${phrase}]]`;
                    
                    editor.replaceRange(linkText, startPos, endPos);
                    new Notice(`Linked: ${bestMatch.displayText}`);
                    return; // Stop after first good match
                }
            }
        }
        new Notice("No matching note found for this phrase.");
    }

    // --- INDEXING LOGIC (Unchanged) ---
    private normalizeText(text: string): string {
        return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
    }

    private async deleteFromIndex(file: TFile) {
        for (const [key, entries] of this.index.entries()) {
            const filtered = entries.filter(entry => entry.notePath !== file.path);
            if (filtered.length > 0) this.index.set(key, filtered);
            else this.index.delete(key);
        }
    }

    private renameInIndex(file: TFile, oldPath: string) {
        for (const [key, entries] of this.index.entries()) {
            const updatedEntries = entries.map(entry => {
                if (entry.notePath === oldPath) {
                    return { ...entry, notePath: file.path, noteTitle: file.basename };
                }
                return entry;
            });
            this.index.set(key, updatedEntries);
        }
    }

    private async buildFullIndex() {
        if (this.isIndexing) return;
        this.isIndexing = true;
        this.index.clear();
        const markdownFiles = this.vault.getMarkdownFiles();
        for (const file of markdownFiles) await this.indexFile(file);
        this.isIndexing = false;
    }

    private async indexFile(file: TFile) {
        if (file.extension !== 'md') return;
        const noteTitle = file.basename;
        const notePath = file.path;

        this.addToIndex(noteTitle, { type: 'title', notePath, noteTitle, target: noteTitle, displayText: noteTitle });

        const metadata = this.metadataCache.getFileCache(file);
        if (metadata?.frontmatter?.tags) {
            const tags = Array.isArray(metadata.frontmatter.tags) ? metadata.frontmatter.tags : metadata.frontmatter.tags.split(',');
            tags.forEach((tag: string) => {
                const cleanTag = tag.trim();
                this.addToIndex(cleanTag, { type: 'tag', notePath, noteTitle, target: cleanTag, displayText: `#${cleanTag}` });
            });
        }
        if (metadata?.headings) {
            metadata.headings.forEach((heading) => {
                this.addToIndex(heading.heading, { type: 'heading', notePath, noteTitle, target: heading.heading, displayText: `${noteTitle} > ${heading.heading}` });
            });
        }
        if (metadata?.sections) {
            metadata.sections.forEach((section) => {
                if (section.id) {
                    this.addToIndex(section.id, { type: 'block', notePath, noteTitle, target: section.id, displayText: `${noteTitle} > #${section.id}` });
                }
            });
        }
    }

    private addToIndex(key: string, entry: IndexEntry) {
        const normalizedKey = this.normalizeText(key);
        const entries = this.index.get(normalizedKey) || [];
        if (!entries.some(e => e.type === entry.type && e.notePath === entry.notePath && e.target === entry.target)) {
            entries.push(entry);
        }
        this.index.set(normalizedKey, entries);
    }

    private debouncedIndexUpdate(file: TFile) {
        if (this.debounceTimeout) clearTimeout(this.debounceTimeout);
        this.debounceTimeout = window.setTimeout(() => {
            this.deleteFromIndex(file);
            this.indexFile(file);
        }, 300);
    }

    public getSuggestions(query: string): IndexEntry[] {
        const normalizedQuery = this.normalizeText(query);
        if (!normalizedQuery) return [];

        const exactMatches: IndexEntry[] = [];
        for (const [key, entries] of this.index.entries()) {
            if (key.startsWith(normalizedQuery)) exactMatches.push(...entries.map(e => ({ ...e, score: 0 })));
        }

        const fuzzyMatches: IndexEntry[] = [];
        for (const [key, entries] of this.index.entries()) {
            if (fuzzyMatch(normalizedQuery, key)) fuzzyMatches.push(...entries.map(e => ({ ...e, score: 0.5 })));
        }

        const allMatches = [...exactMatches, ...fuzzyMatches];
        const uniqueMatches = allMatches.filter((match, index, self) =>
            index === self.findIndex(m => m.type === match.type && m.notePath === match.notePath && m.target === match.target)
        );

        return uniqueMatches.slice(0, 100);
    }
}

// --- SUGGEST UI (The Popup) ---
class AutoLinkerSuggest extends EditorSuggest<IndexEntry> {
    constructor(private plugin: AutoLinker) {
        super(plugin.app);
    }

    onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);
        if (!line) return null;

        const triggerKey = this.plugin.settings.triggerKey;

        // 1. MANUAL MODE CHECK
        // If user set a Trigger Key (e.g. ";"), we REJECT all triggers 
        // unless the key was just typed.
        if (triggerKey && triggerKey.length > 0) {
            const charBeforeCursor = line.substring(cursor.ch - triggerKey.length, cursor.ch);
            if (charBeforeCursor !== triggerKey) return null;
        }

        // 2. PHRASE SCANNING (Standard)
        const sentenceEndRegex = /[.!?]/g;
        let sentenceStart = 0;
        let sentenceEnd = line.length;
        for (let i = cursor.ch - 1; i >= 0; i--) {
            if (/[.!?]/.test(line[i])) { sentenceStart = i + 1; break; }
        }
        for (let i = cursor.ch; i < line.length; i++) {
            if (/[.!?]/.test(line[i])) { sentenceEnd = i; break; }
        }
        while (sentenceStart < sentenceEnd && /\s/.test(line[sentenceStart])) sentenceStart++;
        while (sentenceEnd > sentenceStart && /\s/.test(line[sentenceEnd - 1])) sentenceEnd--;
        const sentence = line.substring(sentenceStart, sentenceEnd);
        const sentenceOffset = sentenceStart;

        const wordsWithIndices: { word: string, start: number, end: number }[] = [];
        let wordRegex = /\b\w[\w\p{L}\p{N}'-]*\b/gu;
        let match;
        while ((match = wordRegex.exec(sentence)) !== null) {
            wordsWithIndices.push({ word: match[0], start: match.index, end: match.index + match[0].length });
        }

        let cursorInSentence = cursor.ch - sentenceOffset;
        let cursorWordIdx = wordsWithIndices.findIndex(w => cursorInSentence >= w.start && cursorInSentence <= w.end);
        if (cursorWordIdx === -1) cursorWordIdx = wordsWithIndices.findIndex(w => cursorInSentence === w.end);
        if (cursorWordIdx === -1) return null;

        for (let span = wordsWithIndices.length; span >= 1; span--) {
            for (let offset = 0; offset <= wordsWithIndices.length - span; offset++) {
                const startIdx = offset;
                const endIdx = startIdx + span - 1;
                const phraseStart = wordsWithIndices[startIdx].start;
                const phraseEnd = wordsWithIndices[endIdx].end;
                if (cursorWordIdx < startIdx || cursorWordIdx > endIdx) continue;
                const phrase = sentence.substring(phraseStart, phraseEnd);
                if (this.plugin.getSuggestions(phrase).length > 0) {
                    return {
                        start: { line: cursor.line, ch: sentenceOffset + phraseStart },
                        end: { line: cursor.line, ch: sentenceOffset + phraseEnd },
                        query: phrase,
                    };
                }
            }
        }
        return null;
    }

    async getSuggestions(context: EditorSuggestContext): Promise<IndexEntry[]> {
        return this.plugin.getSuggestions(context.query);
    }

    renderSuggestion(item: IndexEntry, el: HTMLElement) {
        const container = el.createDiv({ cls: 'auto-linker-suggestion' });
        const iconMap: Record<IndexEntryType, string> = { title: 'file-text', heading: 'heading', block: 'link', tag: 'tag' };
        const icon = container.createDiv({ cls: 'auto-linker-icon' });
        setIcon(icon, iconMap[item.type]);
        const textEl = container.createDiv({ cls: 'auto-linker-text' });
        textEl.createEl('strong', { text: item.displayText });
        container.createEl('small', { text: `${item.type === 'tag' ? 'Tag' : item.type} in ${item.noteTitle}`, cls: 'auto-linker-subtext' });
    }

    selectSuggestion(item: IndexEntry) {
        if (!this.context) return;
        const { editor, start, end, query } = this.context;

        let linkText = '';
        switch (item.type) {
            case 'title': linkText = `[[${item.target}|${query}]]`; break;
            case 'heading': linkText = `[[${item.noteTitle}#${item.target}|${query}]]`; break;
            case 'block': linkText = `[[${item.noteTitle}#^${item.target}|${query}]]`; break;
            case 'tag': linkText = `[[${item.target}|${query}]]`; break;
        }

        editor.replaceRange(linkText, start, end);
    }
}