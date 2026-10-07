// I/O for `<dataFolder>/` only (state.json, state.json.bak, history-YYYY.jsonl[.broken]).
// Notes are never written. Nothing here runs until the deck picker opens; nothing is written
// (not even the folder) until the first rating or an explicit user action.
import { errorMessage } from '../cards/error-message';
import type { KiokuDay, KiokuStateV1, ReviewEvent } from '../review/types';
import { STORE_REASONS, fileUnreadable, folderChangeRefused, historyCorrupt, historyMissing, invalidEvent, historyTruncated, historyUnknownVersion, saveFailed,
  stateUnknownSchema, stateUnreadable } from './reasons';
import { HISTORY_FILE, STATE_BACKUP_FILE, STATE_FILE, appendTarget, brokenFileName, lastRatings, parseHistory, parseState,
  missingAppliedHistory, replayHistory, serializeEvent, serializeState, validateEvent, type HistoryFile,
  type HistoryParse, type LastRating } from './schema';

/** The subset of Obsidian's public `DataAdapter` that Kioku uses (paths are vault-relative). */
export interface StoreAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  append(path: string, data: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  list(path: string): Promise<{ files: string[]; folders: string[] }>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
}

export type StoreProblem =
  | { readonly kind: 'read-only'; readonly message: string }
  /** Only this case offers the confirm button that moves the line to `.broken`. */
  | { readonly kind: 'truncated'; readonly message: string; readonly file: string; readonly line: number; readonly text: string };

export type RecordResult =
  | { readonly ok: true; readonly stateSaved: boolean }
  | { readonly ok: false; readonly reason: string };

export const STATE_TEMP_FILE = 'state.json.tmp';
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
  /** state.json exists on disk (loaded or written); until then nothing but a rating may create files. */
  private stateOnDisk: boolean;
  state: KiokuStateV1;
  problem: StoreProblem | null;

  private constructor(private readonly adapter: StoreAdapter, readonly folder: string, state: KiokuStateV1,
    problem: StoreProblem | null, history: Map<string, HistoryParse>, stateOnDisk: boolean) {
    this.stateOnDisk = stateOnDisk;
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
    // Without state.json (e.g. a crash between removing it and renaming the temp file), the temp file
    // or the backup still tells which history was already applied; a vanished file must not be
    // silently replayed away.
    let inspection = base;
    if (!inspection && !names.includes(STATE_FILE)) {
      for (const candidate of [STATE_TEMP_FILE, STATE_BACKUP_FILE]) {
        if (!names.includes(candidate)) continue;
        try {
          const parsed = parseState(await adapter.read(`${folder}/${candidate}`));
          if (parsed.kind === 'ok') {
            inspection = parsed.state;
            break;
          }
        } catch {
          // An unreadable temp / backup file only loses this extra check.
        }
      }
    }
    const missing = inspection ? missingAppliedHistory(inspection, files) : null;
    if (missing) problems.push({ kind: 'read-only', message: historyMissing(`${folder}/${missing}`) });
    // With problems the replay is only used for display (counts); nothing is written in that mode.
    // With missing history, state.json itself is the better picture of the schedules.
    const state = missing && base ? base : replayHistory(base, files).state;
    // A truncated tail is repairable only when no other problem exists (any read-only problem wins).
    const problem = problems.find((item) => item.kind === 'read-only') ?? problems[0] ?? null;
    return new ReviewStore(adapter, folder, state, problem, history, names.includes(STATE_FILE));
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
    try {
      if (!(await this.adapter.exists(this.folder))) await this.adapter.mkdir(this.folder);
      const existing = [...this.historyFiles.keys(), ...(await this.adapter.list(this.folder)).files.map(baseName)];
      const name = appendTarget(event.day, existing);
      const path = this.path(name);
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
        // Always append (it creates a missing file): a wrong "does not exist" can never replace history.
        await this.adapter.append(path, line);
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

  /**
   * Writes state.json without ever leaving a half-written file: the new content goes to
   * `state.json.tmp` (verified), then replaces state.json by rename. Before the first write of this
   * store the current state.json is re-validated and copied to `.bak`. If the adapter refuses to
   * rename over an existing file, state.json is removed first: a crash in that gap leaves no
   * state.json, which load treats as missing and rebuilds from history (`.bak` and `.tmp` remain).
   */
  async saveState(): Promise<boolean> {
    if (this.problem) return false;
    const path = this.path(STATE_FILE);
    const temp = this.path(STATE_TEMP_FILE);
    try {
      if (!(await this.adapter.exists(this.folder))) await this.adapter.mkdir(this.folder);
      const exists = await this.adapter.exists(path);
      if (!this.backedUp && exists) {
        const text = await this.adapter.read(path);
        // Never replace a file that became unreadable since loading.
        if (parseState(text).kind !== 'ok') return false;
        await this.adapter.write(this.path(STATE_BACKUP_FILE), text);
      }
      this.backedUp = true;
      const content = serializeState(this.state);
      await this.adapter.write(temp, content);
      if (await this.adapter.read(temp) !== content) return false;
      try {
        await this.adapter.rename(temp, path);
      } catch (error) {
        if (!exists) throw error;
        await this.adapter.remove(path);
        await this.adapter.rename(temp, path);
      }
      this.stateOnDisk = true;
      return await this.adapter.read(path) === content;
    } catch {
      return false;
    }
  }

  /**
   * "今日だけ あと N 枚": raises today's new-card limit only (reset on the next Kioku day). Before the
   * first rating nothing is written (design §7.2): the addition stays in memory and is saved with
   * the first rating's state; closing without a rating forgets it. Returns false only when an
   * existing state.json could not be updated.
   */
  async addExtraNew(day: KiokuDay, count: number): Promise<boolean> {
    this.applyExtraNew(day, count);
    return this.stateOnDisk ? this.saveState() : true;
  }

  /** In-memory part of `addExtraNew`, also used to carry an unsaved addition into a reloaded store. */
  applyExtraNew(day: KiokuDay, count: number): void {
    const today = this.state.today?.day === day ? this.state.today : { day, newIntroduced: 0, extraNew: 0 };
    this.state = { ...this.state, today: { ...today, extraNew: today.extraNew + count } };
  }

  /** Each card's last rating in the history files read by `load` (and appended by `record`). */
  lastRatings(): Map<string, LastRating> {
    return lastRatings([...this.historyFiles].map(([name, parse]) => ({ name, parse })));
  }

  get persistsExtraNew(): boolean {
    return this.stateOnDisk;
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
      const broken = await this.adapter.exists(brokenPath) ? await this.adapter.read(brokenPath) : '';
      await this.adapter.append(brokenPath, (broken && !broken.endsWith('\n') ? '\n' : '') + line);
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
