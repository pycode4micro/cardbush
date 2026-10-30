/** Track the ASR-owned suffix, leaving surrounding text and user corrections alone. */
export class DictationDraft {
  private id = '';
  private draft = '';
  private transcript = '';
  private start = 0;
  private end = 0;
  private consumed = 0;

  observe(draft: string) {
    if (!this.id || draft === this.draft) return;
    const owned = this.draft.slice(this.start, this.end), found = owned ? draft.indexOf(owned) : -1;
    if (found >= 0 && found === draft.lastIndexOf(owned)
      && this.draft.indexOf(owned) === this.start && this.draft.lastIndexOf(owned) === this.start) {
      this.start = found; this.end = found + owned.length;
    } else {
      const edit = changedRange(this.draft, draft), delta = edit.newEnd - edit.oldEnd;
      if (edit.oldEnd <= this.start && (edit.start < this.start || this.start < this.end)) { this.start += delta; this.end += delta; }
      else if (edit.start < this.end) {
        // Anything the user changed is now theirs. Only the unedited suffix
        // remains replaceable by partial/final recognition revisions.
        this.consumed += Math.min(this.end, edit.oldEnd) - this.start;
        this.start = edit.newEnd;
        this.end = Math.max(this.start, this.end + delta);
      }
    }
    this.draft = draft;
  }

  update(draft: string, transcript: string, id: string) {
    if (id !== this.id) {
      this.id = id; this.consumed = 0; this.transcript = '';
      const separator = draft && !/\s$/.test(draft) ? ' ' : '';
      draft += separator; this.start = this.end = draft.length; this.draft = draft;
    } else this.observe(draft);
    const revision = changedRange(this.transcript, transcript);
    if (this.consumed > revision.start) {
      this.consumed = this.consumed >= revision.oldEnd
        ? this.consumed + revision.newEnd - revision.oldEnd : revision.newEnd;
    }
    const suffix = transcript.slice(this.consumed);
    this.draft = draft.slice(0, this.start) + suffix + draft.slice(this.end);
    this.end = this.start + suffix.length; this.transcript = transcript;
    return { draft: this.draft, caret: this.end };
  }
}

function changedRange(before: string, after: string) {
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  return { start, oldEnd, newEnd };
}
