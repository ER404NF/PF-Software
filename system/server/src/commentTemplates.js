// The approved preset-comment library (roadmap MS10.2, `/template add|list|remove`).
// A "preset" comment must match one of these word for word; anything else is a
// model-generated comment and goes through the grounding check instead.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_TEXT = 500;

export class TemplateLibrary {
  constructor({ filePath = null, now = () => new Date().toISOString() } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.templates = [];
    if (filePath && fs.existsSync(filePath)) {
      try { this.templates = JSON.parse(fs.readFileSync(filePath, "utf8")).templates ?? []; } catch { this.templates = []; }
    }
  }

  _save() {
    if (!this.filePath) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ templates: this.templates }, null, 2));
    fs.renameSync(temporary, this.filePath);
  }

  add({ workspaceId, text, tags = [], createdBy = null }) {
    const body = typeof text === "string" ? text.trim() : "";
    if (!body || body.length > MAX_TEXT) throw new Error(`A template is 1 to ${MAX_TEXT} characters.`);
    if (/https?:\/\//i.test(body)) throw new Error("A template cannot contain a link.");
    if (this.templates.some(item => item.workspaceId === workspaceId && item.text.toLowerCase() === body.toLowerCase())) {
      throw new Error("That template already exists.");
    }
    const template = { id: `tpl-${crypto.randomUUID()}`, workspaceId, text: body,
      tags: [...new Set((Array.isArray(tags) ? tags : []).map(tag => String(tag).trim().toLowerCase()).filter(Boolean))].slice(0, 10),
      createdBy, createdAt: this.now() };
    this.templates.push(template);
    this._save();
    return template;
  }

  list(workspaceId) {
    return this.templates.filter(item => item.workspaceId === workspaceId);
  }

  get(workspaceId, id) {
    return this.templates.find(item => item.workspaceId === workspaceId && item.id === id) ?? null;
  }

  remove(workspaceId, id) {
    const before = this.templates.length;
    this.templates = this.templates.filter(item => !(item.workspaceId === workspaceId && item.id === id));
    if (this.templates.length !== before) this._save();
    return this.templates.length !== before;
  }
}
