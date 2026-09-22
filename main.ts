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
    Notice,
    prepareFuzzySearch,
    SearchResult
} from 'obsidian';

// --- SETTINGS ---
interface AutoLinkerSettings {
    triggerKey: string;
    minChars: number;
    useFuzzySearch: boolean;
    maxSuggestions: number;
    indexTags: boolean;
    indexHeadings: boolean;
    indexBlocks: boolean;
    useTargetName: boolean; // NEW: Replaces typed text with the actual note name
}

const DEFAULT_SETTINGS: AutoLinkerSettings = {
    triggerKey: '',
    minChars: 3,
    useFuzzySearch: true,
    maxSuggestions: 10,
    indexTags: true,
    indexHeadings: true,
    indexBlocks: false,
    useTargetName: true // Enabled by default
};

// --- TYPES ---
type IndexEntryType = 'title' | 'heading' | 'block' | 'tag';
type IndexEntry = {
    type: IndexEntryType;
    notePath: string;
    noteTitle: string;
    target: string;
    displayText: string;
};

interface MatchResult {
    item: IndexEntry;
    match: SearchResult;
}

// --- MAIN PLUGIN CLASS ---
export default class AutoLinker extends Plugin {
    public settings!: AutoLinkerSettings;
    public forceTrigger: boolean = false;
    
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

            this.addSettingTab(new AutoLinkerSettingTab(this.app, this));

            this.addCommand({
                id: 'reload-auto-linker',
                name: 'Reload Plugin',
                callback: () => this.reloadSelf()
            });

            this.addCommand({
                id: 'auto-linker-quick-link',
                name: 'Convert phrase to link (Exact Match)',
                editorCallback: (editor: Editor) => this.runQuickLink(editor)
            });

            this.addCommand({
                id: 'force-trigger-auto-linker',
                name: 'Force trigger link suggestion (ignore min characters)',
                editorCallback: (editor: Editor) => {
                    this.forceTrigger = true;
                    const cursor = editor.getCursor();
                    editor.replaceRange(' ', cursor);
                    editor.replaceRange('', cursor, { line: cursor.line, ch: cursor.ch + 1 });
                }
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
        await this.buildFullIndex();
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
        this.addRibbonIcon('refresh-cw', 'Reload Auto Linker', () => this.reloadSelf());
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

    private runQuickLink(editor: Editor) {
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        
        let sentenceStart = 0, sentenceEnd = line.length;
        for (let i = cursor.ch - 1; i >= 0; i--) { if (/[.!?]/.test(line[i])) { sentenceStart = i + 1; break; } }
        for (let i = cursor.ch; i < line.length; i++) { if (/[.!?]/.test(line[i])) { sentenceEnd = i; break; } }
        while (sentenceStart < sentenceEnd && /\s/.test(line[sentenceStart])) sentenceStart++;
        
        const sentence = line.substring(sentenceStart, sentenceEnd);
        const sentenceOffset = sentenceStart;

        const wordsWithIndices: { word: string, start: number, end: number }[] = [];
        let wordRegex = /\b\w[\w\p{L}\p{N}'-]*\b/gu, match;
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

        for (let span = wordsWithIndices.length; span >= 1; span--) {
            for (let offset = 0; offset <= wordsWithIndices.length - span; offset++) {
                const startIdx = offset, endIdx = startIdx + span - 1;
                if (cursorWordIdx < startIdx || cursorWordIdx > endIdx) continue;

                const phraseStart = wordsWithIndices[startIdx].start;
                const phraseEnd = wordsWithIndices[endIdx].end;
                const phrase = sentence.substring(phraseStart, phraseEnd);
                
                const bestMatch = this.getExactMatch(phrase);

                if (bestMatch) {
                    const startPos = { line: cursor.line, ch: sentenceOffset + phraseStart };
                    const endPos = { line: cursor.line, ch: sentenceOffset + phraseEnd };
                    
                    let linkText = `[[${bestMatch.target}|${phrase}]]`;
                    if (bestMatch.type === 'heading') linkText = `[[${bestMatch.noteTitle}#${bestMatch.target}|${phrase}]]`;
                    if (bestMatch.type === 'block') linkText = `[[${bestMatch.noteTitle}#^${bestMatch.target}|${phrase}]]`;
                    
                    editor.replaceRange(linkText, startPos, endPos);
                    new Notice(`Linked: ${bestMatch.displayText}`);
                    return;
                }
            }
        }
        new Notice("No exact matching note found for this phrase.");
    }

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
        
        if (this.settings.indexTags && metadata?.frontmatter?.tags) {
            const tags = Array.isArray(metadata.frontmatter.tags) ? metadata.frontmatter.tags : metadata.frontmatter.tags.split(',');
            tags.forEach((tag: string) => {
                const cleanTag = tag.trim();
                this.addToIndex(cleanTag, { type: 'tag', notePath, noteTitle, target: cleanTag, displayText: `#${cleanTag}` });
            });
        }
        if (this.settings.indexHeadings && metadata?.headings) {
            metadata.headings.forEach((heading) => {
                this.addToIndex(heading.heading, { type: 'heading', notePath, noteTitle, target: heading.heading, displayText: `${noteTitle} > ${heading.heading}` });
            });
        }
        if (this.settings.indexBlocks && metadata?.sections) {
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

    public getExactMatch(query: string): IndexEntry | undefined {
        const normalizedQuery = this.normalizeText(query);
        const entries = this.index.get(normalizedQuery);
        return entries && entries.length > 0 ? entries[0] : undefined;
    }

    public getSearchSuggestions(query: string): MatchResult[] {
        if (!query) return [];
        
        const fuzzySearch = this.settings.useFuzzySearch ? prepareFuzzySearch(query) : null;
        const queryLower = query.toLowerCase();
        
        const results: MatchResult[] = [];
        const seen = new Set<string>();

        for (const entries of this.index.values()) {
            for (const entry of entries) {
                const uniqueKey = `${entry.type}-${entry.notePath}-${entry.target}`;
                if (seen.has(uniqueKey)) continue;

                let match: SearchResult | null = null;

                if (this.settings.useFuzzySearch && fuzzySearch) {
                    match = fuzzySearch(entry.displayText);
                } else {
                    const textLower = entry.displayText.toLowerCase();
                    const idx = textLower.indexOf(queryLower);
                    if (idx !== -1) {
                        match = {
                            score: 0,
                            matches: [[idx, idx + query.length]]
                        };
                    }
                }

                if (match) {
                    results.push({ item: entry, match });
                    seen.add(uniqueKey);
                }
            }
        }

        if (this.settings.useFuzzySearch) {
            results.sort((a, b) => b.match.score - a.match.score);
        } else {
            results.sort((a, b) => a.item.displayText.length - b.item.displayText.length);
        }
        
        return results.slice(0, this.settings.maxSuggestions);
    }

    private debouncedIndexUpdate(file: TFile) {
        if (this.debounceTimeout) clearTimeout(this.debounceTimeout);
        this.debounceTimeout = window.setTimeout(() => {
            this.deleteFromIndex(file);
            this.indexFile(file);
        }, 300);
    }
}

// --- SUGGEST UI (The Popup) ---
class AutoLinkerSuggest extends EditorSuggest<MatchResult> {
    constructor(private plugin: AutoLinker) {
        super(plugin.app);

        // Update the visual instructions on the popup
        this.setInstructions([
            { command: 'Tab', purpose: 'Select' },
            { command: 'Enter', purpose: 'New Line' },
            { command: '↑↓', purpose: 'Navigate' },
            { command: 'Esc', purpose: 'Dismiss' }
        ]);

        // Hack to override default keyboard behavior in Obsidian Suggests
        // @ts-ignore
        if (this.scope && this.scope.keys) {
            // Remove the default 'Enter' key handler so Enter falls through to the editor (makes a new line)
            // @ts-ignore
            this.scope.keys = this.scope.keys.filter(k => k.key !== "Enter");
        }

        // Register Tab to perform the selection instead
        this.scope.register([], "Tab", (evt: KeyboardEvent) => {
            evt.preventDefault();
            // @ts-ignore
            this.suggestions.useSelectedItem(evt);
            return false;
        });
    }

    onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
        const line = editor.getLine(cursor.line);
        if (!line) return null;

        const textBeforeCursor = line.substring(0, cursor.ch);
        const triggerKey = this.plugin.settings.triggerKey;

        let query = '';
        let startCh = 0;

        if (triggerKey && triggerKey.length > 0) {
            const lastTriggerIdx = textBeforeCursor.lastIndexOf(triggerKey);
            if (lastTriggerIdx === -1) return null;

            query = textBeforeCursor.substring(lastTriggerIdx + triggerKey.length);
            startCh = lastTriggerIdx;
        } 
        else {
            const match = textBeforeCursor.match(/([a-zA-Z0-9_-]+)$/);
            if (!match) return null;
            
            query = match[1];
            startCh = match.index!;
        }

        if (!this.plugin.forceTrigger && query.length < this.plugin.settings.minChars) {
            return null;
        }

        this.plugin.forceTrigger = false;

        return {
            start: { line: cursor.line, ch: startCh },
            end: cursor,
            query: query
        };
    }

    async getSuggestions(context: EditorSuggestContext): Promise<MatchResult[]> {
        return this.plugin.getSearchSuggestions(context.query);
    }

    renderSuggestion(suggestion: MatchResult, el: HTMLElement) {
        const { item, match } = suggestion;
        const container = el.createDiv({ cls: 'auto-linker-suggestion' });
        
        const iconMap: Record<IndexEntryType, string> = { title: 'file-text', heading: 'heading', block: 'link', tag: 'tag' };
        const icon = container.createDiv({ cls: 'auto-linker-icon' });
        setIcon(icon, iconMap[item.type]);

        const textEl = container.createDiv({ cls: 'auto-linker-text' });
        const titleEl = textEl.createEl('strong');
        
        if (match.matches && match.matches.length > 0) {
            let lastIndex = 0;
            const text = item.displayText;
            for (const [start, end] of match.matches) {
                if (start > lastIndex) {
                    titleEl.appendText(text.substring(lastIndex, start));
                }
                titleEl.createSpan({ cls: 'suggestion-highlight', text: text.substring(start, end) });
                lastIndex = end;
            }
            if (lastIndex < text.length) {
                titleEl.appendText(text.substring(lastIndex));
            }
        } else {
            titleEl.setText(item.displayText);
        }

        const subText = item.type === 'tag' ? 'Tag' : `${item.type} in ${item.noteTitle}`;
        container.createEl('small', { text: subText, cls: 'auto-linker-subtext' });
    }

    selectSuggestion(suggestion: MatchResult) {
        if (!this.context) return;
        const { editor, start, end, query } = this.context;
        const item = suggestion.item;

        // If the setting is true, override the alias with the exact target name!
        let alias = query;
        if (this.plugin.settings.useTargetName || this.plugin.settings.triggerKey) {
            alias = item.target;
        }

        let linkText = '';

        switch (item.type) {
            case 'title': linkText = `[[${item.target}|${alias}]]`; break;
            case 'heading': linkText = `[[${item.noteTitle}#${item.target}|${alias}]]`; break;
            case 'block': linkText = `[[${item.noteTitle}#^${item.target}|${alias}]]`; break;
            case 'tag': linkText = `[[${item.target}|${alias}]]`; break;
        }

        // Clean up redundant aliases (e.g., [[Target|Target]] -> [[Target]])
        linkText = linkText.replace(`|${item.target}]]`, "]]");
        editor.replaceRange(linkText, start, end);
    }
}

// --- SETTINGS TAB UI ---
class AutoLinkerSettingTab extends PluginSettingTab {
    plugin: AutoLinker;

    constructor(app: App, plugin: AutoLinker) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Auto Linker Settings' });

        new Setting(containerEl)
            .setName('Replace with Target Name')
            .setDesc('When hitting Tab, replace the text you typed with the exact Note Name instead of creating an alias. (Highly recommended for fuzzy search).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useTargetName)
                .onChange(async (value) => {
                    this.plugin.settings.useTargetName = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Trigger Key')
            .setDesc('Character used to manually trigger suggestions (e.g., "@"). Leave empty to enable Auto Mode (always scan text).')
            .addText(text => text
                .setPlaceholder('Leave empty for auto')
                .setValue(this.plugin.settings.triggerKey)
                .onChange(async (value) => {
                    this.plugin.settings.triggerKey = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Minimum Characters')
            .setDesc('How many characters do you need to type before suggestions pop up? (Useful for Auto Mode to avoid noise)')
            .addText(text => text
                .setPlaceholder('3')
                .setValue(this.plugin.settings.minChars.toString())
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.minChars = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Use Fuzzy Search')
            .setDesc('Allows typo-tolerant matching (e.g., "nt" finds "Note"). If disabled, requires exact partial matching.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.useFuzzySearch)
                .onChange(async (value) => {
                    this.plugin.settings.useFuzzySearch = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Max Suggestions')
            .setDesc('Maximum number of items to show in the pop-up list.')
            .addText(text => text
                .setPlaceholder('10')
                .setValue(this.plugin.settings.maxSuggestions.toString())
                .onChange(async (value) => {
                    const parsed = parseInt(value, 10);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.maxSuggestions = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        containerEl.createEl('h3', { text: 'What to index' });

        new Setting(containerEl)
            .setName('Index Tags')
            .setDesc('Include frontmatter tags in auto-link suggestions.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.indexTags)
                .onChange(async (value) => {
                    this.plugin.settings.indexTags = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Index Headings')
            .setDesc('Include note headings (H1-H6) in auto-link suggestions.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.indexHeadings)
                .onChange(async (value) => {
                    this.plugin.settings.indexHeadings = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Index Blocks')
            .setDesc('Include individual paragraph block IDs (Warning: Can clutter suggestions in a large vault).')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.indexBlocks)
                .onChange(async (value) => {
                    this.plugin.settings.indexBlocks = value;
                    await this.plugin.saveSettings();
                }));
    }
}
