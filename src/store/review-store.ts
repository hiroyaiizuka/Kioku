// I/O for `<dataFolder>/` only (state.json, state.json.bak, history-YYYY.jsonl[.broken]).
// Notes are never written. Nothing here runs until the deck picker opens; nothing is written
// (not even the folder) until the first rating or an explicit user action.
import { errorMessage } from '../cards/error-message';
import type { KiokuDay, KiokuStateV1, ReviewEvent } from '../review/types';
import { STORE_REASONS, fileUnreadable, folderChangeRefused, historyCorrupt, historyMissing, invalidEvent, historyTruncated, historyUnknownVersion, saveFailed,
  stateUnknownSchema, stateUnreadable } from './reasons';
import { HISTORY_FILE, STATE_BACKUP_FILE, STATE_FILE, brokenFileName, historyFileName, parseHistory, parseState,
  missingAppliedHistory, replayHistory, serializeEvent, serializeState, validateEvent, type HistoryFile,
  type HistoryParse } from './schema';

/** The subset of Obsidian's public `DataAdapter` that Kioku uses (paths are vault-relative). */
export interface StoreAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
}

export type StoreProblem =
  | { readonly kind: 'read-only'; readonly message: string }
  /** Only this case offers the confirm button that moves the line to `.broken`. */
  | { readonly kind: 'truncated'; readonly message: string; readonly file: string; readonly line: number; readonly text: string };

export type RecordResult =
  | { readonly ok: true; readonly stateSaved: boolean }
  | { readonly ok: false; readonly reason: string };

const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** True when `folder` holds Kioku data (state, its backup or a history file). */
export async function folderHasData(adapter: StoreAdapter, folder: string): Promise<boolean> {
  if (!(await adapter.exists(folder))) return false;
  const { files } = await adapter.list(folder);
  return files.map(baseName).some((name) => name === STATE_FILE || name === STATE_BACKUP_FILE || HISTORY_FILE.test(name));
}

/**
 * The data-folder change guard (docs/m2-design.md §7.1): files are never moved by Kioku. Refuse
 * when the new folder has no data while the old one has, instead of silently starting empty.
 * Returns the refusal text, or null when the change may be applied.
 */
export async function checkFolderChange(adapter: StoreAdapter, from: string, to: string): Promise<string | null> {
  if (from === to) return null;
  if (await folderHasData(adapter, to)) return null;
  return await folderHasData(adapter, from) ? folderChangeRefused(from) : null;
}

function historyProblem(path: string, parse: HistoryParse): StoreProblem | null {
  const problem = parse.problem;
  if (!problem) return null;
  if (problem.kind === 'truncated') {
    return { kind: 'truncated', message: historyTruncated(path, problem.line), file: baseName(path), line: problem.line, text: problem.text };
  }
  if (problem.kind === 'unknown-version') return { kind: 'read-only', message: historyUnknownVersion(path, problem.line, problem.version) };
  return { kind: 'read-only', message: historyCorrupt(path, problem.line) };
}

export class ReviewStore {
  private historyFiles = new Map<string, HistoryParse>();
  private backedUp = false;
  state: KiokuStateV1;
  problem: StoreProblem | null;

  private constructor(private readonly adapter: StoreAdapter, readonly folder: string, state: KiokuStateV1,
    problem: StoreProblem | null, history: Map<string, HistoryParse>) {
    this.state = state;
    this.problem = problem;
    this.historyFiles = history;
  }

  get readOnly(): boolean {
    return this.problem !== null;
  }

  private path(name: string): string {
    return `${this.folder}/${name}`;
  }

  /**
   * Reads state and history without writing anything. A missing file means "new"; a file that
   * exists but cannot be read or validated makes the store read-only (it is never overwritten).
   */
  static async load(adapter: StoreAdapter, folder: string): Promise<ReviewStore> {
    const history = new Map<string, HistoryParse>();
    const problems: StoreProblem[] = [];
    let base: KiokuStateV1 | null = null;
    let names: string[] = [];
    try {
      if (await adapter.exists(folder)) names = (await adapter.list(folder)).files.map(baseName);
    } catch (error) {
      problems.push({ kind: 'read-only', message: fileUnreadable(folder, errorMessage(error)) });
    }
    if (names.includes(STATE_FILE)) {
      const path = `${folder}/${STATE_FILE}`;
      try {
        const parsed = parseState(await adapter.read(path));
        if (parsed.kind === 'ok') base = parsed.state;
        else if (parsed.kind === 'unknown-schema') problems.push({ kind: 'read-only', message: stateUnknownSchema(path, parsed.version) });
        else problems.push({ kind: 'read-only', message: stateUnreadable(path, parsed.detail) });
      } catch (error) {
        problems.push({ kind: 'read-only', message: stateUnreadable(path, errorMessage(error)) });
      }
    }
    for (const name of names.filter((item) => HISTORY_FILE.test(item)).sort()) {
      const path = `${folder}/${name}`;
      try {
        const parse = parseHistory(await adapter.read(path));
        history.set(name, parse);
        const problem = historyProblem(path, parse);
        if (problem) problems.push(problem);
      } catch (error) {
        problems.push({ kind: 'read-only', message: fileUnreadable(path, errorMessage(error)) });
      }
    }
    const files: HistoryFile[] = [...history].map(([name, parse]) => ({ name, parse }));
    const missing = base ? missingAppliedHistory(base, files) : null;
    if (missing) problems.push({ kind: 'read-only', message: historyMissing(`${folder}/${missing}`) });
    // With problems the replay is only used for display (counts); nothing is written in that mode.
    // With missing history, state.json itself is the better picture of the schedules.
    const state = missing && base ? base : replayHistory(base, files).state;
    // A truncated tail is repairable only when it is the only problem.
    const problem = problems.find((item) => item.kind === 'read-only') ?? problems[0] ?? null;
    return new ReviewStore(adapter, folder, state, problem, history);
  }

  /**
   * Saves one rating: append the event to the year's history, read it back, and only then count it
   * as saved; then update state.json (a failure there loses nothing: history is the source of truth).
   * A retry must pass the same event; if its eventId is already the last line, nothing is appended.
   */
  async record(event: ReviewEvent): Promise<RecordResult> {
    if (this.problem) return { ok: false, reason: this.problem.kind === 'truncated' ? this.problem.message : STORE_REASONS.readOnly };
    // Never append a line that replay would reject (it would make the history read-only).
    if (!validateEvent(JSON.parse(JSON.stringify(event)))) return { ok: false, reason: invalidEvent };
    const name = historyFileName(event.day);
    const path = this.path(name);
    try {
      if (!(await this.adapter.exists(this.folder))) await this.adapter.mkdir(this.folder);
      const exists = await this.adapter.exists(path);
      const before = exists ? await this.adapter.read(path) : '';
      const current = parseHistory(before);
      const applied = this.state.applied[name];
      const problem = historyProblem(path, current)
        ?? (applied && current.lines < applied.lines ? { kind: 'read-only' as const, message: historyMissing(path) } : null);
      if (problem) {
        this.problem = problem;
        return { ok: false, reason: problem.message };
      }
      if (current.entries[current.entries.length - 1]?.event.eventId !== event.eventId) {
        // Never write after a line without its line break: complete it first.
        const line = (current.missingFinalNewline ? '\n' : '') + serializeEvent(event);
        if (exists) await this.adapter.append(path, line);
        else await this.adapter.write(path, line);
      }
      const after = parseHistory(await this.adapter.read(path));
      if (after.problem || after.entries[after.entries.length - 1]?.event.eventId !== event.eventId) {
        return { ok: false, reason: STORE_REASONS.unconfirmed };
      }
      this.historyFiles.set(name, after);
    } catch (error) {
      return { ok: false, reason: saveFailed(errorMessage(error)) };
    }
    this.state = replayHistory(this.state, [...this.historyFiles].map(([file, parse]) => ({ name: file, parse }))).state;
    return { ok: true, stateSaved: await this.saveState() };
  }

  /** Writes state.json; before the first write of this store, copies the current file to `.bak`. */
  async saveState(): Promise<boolean> {
    if (this.problem) return false;
    const path = this.path(STATE_FILE);
    try {
      if (!(await this.adapter.exists(this.folder))) await this.adapter.mkdir(this.folder);
      if (!this.backedUp && await this.adapter.exists(path)) {
        const text = await this.adapter.read(path);
        // Never replace a file that became unreadable since loading.
        if (parseState(text).kind !== 'ok') return false;
        await this.adapter.write(this.path(STATE_BACKUP_FILE), text);
      }
      this.backedUp = true;
      await this.adapter.write(path, serializeState(this.state));
      return true;
    } catch {
      return false;
    }
  }

  /** "今日だけ あと N 枚": raises today's new-card limit only (reset on the next Kioku day). */
  async addExtraNew(day: KiokuDay, count: number): Promise<boolean> {
    const today = this.state.today?.day === day ? this.state.today : { day, newIntroduced: 0, extraNew: 0 };
    this.state = { ...this.state, today: { ...today, extraNew: today.extraNew + count } };
    return this.saveState();
  }

  /**
   * The user confirmed moving the truncated last line: append it to `history-YYYY.jsonl.broken`
   * first (verified), then remove only that line from the history file (verified), then reload.
   */
  async repairTruncated(): Promise<{ readonly ok: true; readonly store: ReviewStore } | { readonly ok: false; readonly reason: string }> {
    const problem = this.problem;
    if (problem?.kind !== 'truncated') return { ok: false, reason: STORE_REASONS.readOnly };
    const path = this.path(problem.file);
    const brokenPath = this.path(brokenFileName(problem.file));
    try {
      const text = await this.adapter.read(path);
      const parse = parseHistory(text);
      if (parse.problem?.kind !== 'truncated' || parse.problem.line !== problem.line || parse.problem.text !== problem.text) {
        return { ok: false, reason: '記録ファイルが確認後に変更されました。デッキ選択を開き直してください。' };
      }
      const kept = text.slice(0, parse.problem.start);
      const line = `${problem.text}\n`;
      if (await this.adapter.exists(brokenPath)) {
        const broken = await this.adapter.read(brokenPath);
        await this.adapter.append(brokenPath, (broken && !broken.endsWith('\n') ? '\n' : '') + line);
      } else {
        await this.adapter.write(brokenPath, line);
      }
      if (!(await this.adapter.read(brokenPath)).endsWith(line)) {
        return { ok: false, reason: `退避先 ${brokenPath} への書き込みを確認できませんでした。記録ファイルは変更していません。` };
      }
      await this.adapter.write(path, kept);
      if (await this.adapter.read(path) !== kept) {
        return { ok: false, reason: `${path} の更新を確認できませんでした。退避した行は ${brokenPath} にあります。` };
      }
    } catch (error) {
      return { ok: false, reason: saveFailed(errorMessage(error)) };
    }
    return { ok: true, store: await ReviewStore.load(this.adapter, this.folder) };
  }
}
