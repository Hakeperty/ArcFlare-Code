"use strict";
// What the phone remembers about how models are run: for now, which Arc.
//
// Kept on the computer, in <hub>/settings.json, rather than in the phone's
// browser storage. A setting that changes what every chat and agent is told
// belongs with the hub that runs them: it survives clearing the app, it is the
// same on every phone and browser signed in, and the Android app's "Forget
// this computer" does not have to know about it.
//
// The Arc chosen here is added to chats and agents started through the hub. It
// is separate from `arc` in ~/.arcflare/config.json (what `arcflare arcs use`
// sets for the terminal), so choosing one on the phone does not change what
// someone at the keyboard gets.

const fs = require("fs");
const path = require("path");

class HubSettings {
  /**
   * @param {object} o
   * @param {string} o.dir    hub state folder
   * @param {object} [o.arcs] lib/arcs.js (tests inject a fake)
   */
  constructor(o = {}) {
    this.file = path.join(o.dir, "settings.json");
    this.arcs = o.arcs || require("../arcs");
    this.data = this._read();
  }

  _read() {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return j && typeof j === "object" && !Array.isArray(j) ? j : {};
    } catch { return {}; }
  }

  _save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** The Arc in use for the hub's chats and agents, or null. An Arc that no longer exists counts as none. */
  arc() {
    const id = typeof this.data.arc === "string" ? this.data.arc : null;
    return id ? this.arcs.find(id) : null;
  }

  /** Choose an Arc by id, or pass null/"" for none. */
  setArc(id) {
    if (id === null || id === undefined || id === "") {
      delete this.data.arc;
    } else {
      const a = typeof id === "string" ? this.arcs.find(id) : null;
      if (!a) throw Object.assign(new Error("No such Arc"), { status: 400 });
      this.data.arc = a.id;
    }
    this._save();
    return this.view();
  }

  /** What a phone may see: the choice, and each Arc's name and purpose. Never an Arc's instructions. */
  view() {
    const cur = this.arc();
    return {
      arc: cur ? cur.id : null,
      arcs: this.arcs.all().map((a) => ({ id: a.id, name: a.name, focus: a.focus, side: a.side, group: a.group })),
    };
  }
}

module.exports = { HubSettings };
