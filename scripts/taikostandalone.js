/*
 * taikostandalone.js
 *
 * Fully self-contained osu!taiko player that runs straight from a local HTML
 * file (file://) — no server, no Node, no network.
 *
 * It avoids every browser feature that is blocked on file:// :
 *   - zip.js runs WITHOUT web workers (zip.useWebWorkers = false + inflate.js)
 *   - beatmaps are opened from a local <input type=file> (.osz), never fetched
 *   - no sprite atlas / bitmap fonts: the HUD is plain PIXI.Text
 *   - hit-sounds are synthesised with the Web Audio API (no .ogg files)
 *   - skins are loaded from a local .osk file picker
 *
 * Dependencies (all loaded as plain <script> tags, which work on file://):
 *   PIXI v7, zip.js + inflate.js + zip-fs.js
 */
(function () {
    "use strict";

    if (window.zip) {
        zip.useWebWorkers = false; // critical: workers are blocked on file://
        // inflate.js exposes the inflater as window.Inflater; the no-worker
        // code path in zip.js looks for it at zip.Inflater.
        if (window.Inflater && !zip.Inflater) zip.Inflater = window.Inflater;
    }

    // ============================================================ utilities
    function $(id) { return document.getElementById(id); }
    function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

    // ---- mods (selected via the Mods screen, applied at startGame) ----
    var Mods = { ez: false, hr: false, hd: false, ht: false, dt: false, nf: false };
    function toggleMod(m) {
        Mods[m] = !Mods[m];
        if (Mods[m]) { // mutually exclusive pairs
            if (m === "ez") Mods.hr = false; else if (m === "hr") Mods.ez = false;
            else if (m === "ht") Mods.dt = false; else if (m === "dt") Mods.ht = false;
        }
    }
    function refreshModButtons() {
        Array.prototype.forEach.call(document.querySelectorAll(".modbtn"), function (btn) {
            btn.classList.toggle("active", !!Mods[btn.getAttribute("data-mod")]);
        });
    }
    function modRate() { return Mods.ht ? 0.75 : (Mods.dt ? 1.5 : 1.0); }
    function modsText(m) {
        m = m || {}; var l = [];
        if (m.ez) l.push("EZ"); if (m.hr) l.push("HR"); if (m.hd) l.push("HD");
        if (m.ht) l.push("HT"); if (m.dt) l.push("DT"); if (m.nf) l.push("NF");
        return l.length ? ("+" + l.join("")) : "";
    }
    // osu! difficulty range mapping: value at OD 0 (min), OD 5 (mid), OD 10 (max).
    function difficultyRange(d, min, mid, max) {
        if (d > 5) return mid + (max - mid) * (d - 5) / 5;
        if (d < 5) return mid - (mid - min) * (5 - d) / 5;
        return mid;
    }

    // ============================================================ .osu parser
    // Only what osu!taiko needs: general, difficulty, timing points, hit objects.
    function parseOsu(text) {
        var lines = text.replace(/\r/g, "").split("\n");
        var section = null;
        var t = {
            general: {}, metadata: {}, difficulty: {},
            timingPoints: [], hitObjects: [], events: []
        };
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line || line.indexOf("//") === 0) continue;
            if (line[0] === "[") { section = line; continue; }
            if (section === "[General]" || section === "[Metadata]" || section === "[Difficulty]") {
                var ci = line.indexOf(":");
                if (ci < 0) continue;
                var key = line.substr(0, ci).trim();
                var val = line.substr(ci + 1).trim();
                var num = parseFloat(val);
                var store = section === "[General]" ? t.general : section === "[Metadata]" ? t.metadata : t.difficulty;
                store[key] = (val !== "" && !isNaN(num) && ("" + num) === val) ? num : (isNaN(num) ? val : num);
            } else if (section === "[Events]") {
                t.events.push(line.split(","));
            } else if (section === "[TimingPoints]") {
                var p = line.split(",");
                t.timingPoints.push({
                    offset: +p[0], msPerBeat: +p[1], meter: +p[2],
                    uninherited: p.length > 6 ? +p[6] : 1,
                    kiai: p.length > 7 ? (+p[7] & 1) : 0
                });
            } else if (section === "[HitObjects]") {
                var q = line.split(",");
                var h = { x: +q[0], y: +q[1], time: +q[2], type: +q[3], hitSound: +q[4] };
                if (h.type & 1) { h.kind = "circle"; }
                else if (h.type & 2) {
                    h.kind = "slider";
                    h.repeat = +q[6];
                    h.pixelLength = +q[7];
                } else if (h.type & 8) {
                    h.kind = "spinner";
                    h.endTime = +q[5];
                } else { continue; }
                t.hitObjects.push(h);
            }
        }
        // defaults
        if (t.difficulty.SliderMultiplier === undefined) t.difficulty.SliderMultiplier = 1.4;
        if (t.difficulty.OverallDifficulty === undefined) t.difficulty.OverallDifficulty = 5;
        if (t.difficulty.HPDrainRate === undefined) t.difficulty.HPDrainRate = 5;

        // resolve inherited timing (slider velocity), mirroring osu! behaviour
        var last = t.timingPoints[0];
        if (!last) { last = { offset: 0, msPerBeat: 500, uninherited: 1 }; t.timingPoints.push(last); }
        for (var k = 0; k < t.timingPoints.length; k++) {
            var pt = t.timingPoints[k];
            if (pt.msPerBeat < 0) pt.uninherited = 0;
            if (pt.uninherited === 0) {
                pt.msPerBeat = last.msPerBeat * (-0.01 * pt.msPerBeat);
            } else { last = pt; }
        }
        // assign timing point to each hit object & compute end times
        var ti = 0;
        for (var j = 0; j < t.hitObjects.length; j++) {
            var ho = t.hitObjects[j];
            while (ti + 1 < t.timingPoints.length && t.timingPoints[ti + 1].offset <= ho.time) ti++;
            ho.timing = t.timingPoints[ti];
            if (ho.kind === "circle") ho.endTime = ho.time;
            else if (ho.kind === "slider") {
                var st = ho.timing.msPerBeat * (ho.pixelLength / t.difficulty.SliderMultiplier) / 100;
                ho.endTime = ho.time + st * Math.max(1, ho.repeat);
            } else if (ho.kind === "spinner") {
                if (!(ho.endTime > ho.time)) ho.endTime = ho.time + 1;
            }
        }
        return t;
    }

    // ============================================================ audio
    var actx = new (window.AudioContext || window.webkitAudioContext)();
    function ensureAudio() { if (actx.state === "suspended") actx.resume(); }

    function decodeAudio(arrayBuffer) {
        return new Promise(function (res, rej) {
            actx.decodeAudioData(arrayBuffer, res, rej);
        });
    }

    function AudioPlayer(buffer, masterVol, rate) {
        var self = this;
        this.rate = rate || 1;            // playback speed (HT 0.75 / DT 1.5)
        this.gain = actx.createGain();
        this.gain.gain.value = masterVol;
        this.gain.connect(actx.destination);
        this.buffer = buffer;
        this.t0 = 0; this.src = null; this.started = false;
        this.start = function (leadInMs) {
            this.src = actx.createBufferSource();
            this.src.buffer = buffer;
            this.src.playbackRate.value = this.rate;
            this.src.connect(this.gain);
            this.t0 = actx.currentTime + leadInMs / 1000;
            this.src.start(this.t0, 0);
            this.started = true;
        };
        // song-time in ms (scaled by playback rate so note timing stays in map time)
        this.getMs = function () { return (actx.currentTime - this.t0) * 1000 * this.rate; };
        this.suspend = function () { return actx.suspend(); };
        this.resume = function () { return actx.resume(); };
        this.stop = function () { try { if (this.src) this.src.stop(); } catch (e) { } };
        this.setVolume = function (v) { this.gain.gain.value = v; };
    }

    // Song preview played on the difficulty-select screen (after a download or
    // local load). Uses a plain <audio> element so it also works on file://.
    var Preview = {
        el: null, url: null,
        stop: function () {
            if (this.el) { try { this.el.pause(); } catch (e) { } this.el = null; }
            if (this.url) { try { URL.revokeObjectURL(this.url); } catch (e) { } this.url = null; }
        },
        play: function (blob, startMs) {
            this.stop();
            var url = URL.createObjectURL(blob);
            var a = new Audio();
            a.src = url; a.loop = true;
            var volEl = $("opt-volume");
            a.volume = volEl ? Math.max(0, Math.min(1, parseFloat(volEl.value) / 100)) : 0.6;
            a.addEventListener("loadedmetadata", function () {
                var s = startMs > 0 ? startMs / 1000 : 0;
                if (isFinite(a.duration) && s > 0 && s < a.duration) { try { a.currentTime = s; } catch (e) { } }
                a.play().catch(function () { });
            });
            this.el = a; this.url = url;
        }
    };

    function startPreview(tracks, entries) {
        Preview.stop();
        if (!tracks.length) return;
        var t = tracks[0];
        var audioName = (t.general.AudioFilename || "").toLowerCase();
        if (!audioName) return;
        var audioEntry = entries.filter(function (e) { return e.name.toLowerCase() === audioName; })[0];
        if (!audioEntry) return;
        audioEntry.getBlob("audio/mpeg", function (blob) {
            Preview.play(blob, +t.general.PreviewTime || 0);
        });
    }

    // synthesised taiko drum hits (no audio files needed)
    function drumSound(kat, big, vol) {
        ensureAudio();
        var now = actx.currentTime;
        var g = actx.createGain();
        g.connect(actx.destination);
        var dur = kat ? 0.08 : 0.12;
        g.gain.setValueAtTime((big ? 1.0 : 0.7) * vol, now);
        g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
        var osc = actx.createOscillator();
        osc.type = kat ? "triangle" : "sine";
        osc.frequency.setValueAtTime(kat ? 440 : 180, now);
        osc.frequency.exponentialRampToValueAtTime(kat ? 220 : 90, now + dur);
        osc.connect(g);
        osc.start(now); osc.stop(now + dur);
        if (kat) { // add a short noise click for the rim sound
            var nb = actx.createBuffer(1, actx.sampleRate * 0.03, actx.sampleRate);
            var d = nb.getChannelData(0);
            for (var i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
            var ns = actx.createBufferSource(); ns.buffer = nb;
            var ng = actx.createGain(); ng.gain.value = 0.25 * vol;
            ns.connect(ng); ng.connect(actx.destination); ns.start(now);
        }
    }

    // Default taiko hit-sounds: bundled osu! drum samples played through pooled
    // <audio> elements (which DO work on file://). Falls back to the synth above
    // if a sample can't be loaded. A loaded .osk may replace these.
    var Sound = {
        // 4sbet1 default taiko drum samples (.wav, identical to the 4sbet1 skin)
        files: { don: "hitsounds/drum-hitnormal.wav", bigdon: "hitsounds/drum-hitfinish.wav", kat: "hitsounds/drum-hitclap.wav" },
        pool: {}, idx: {}, ok: {},
        init: function () {
            var self = this;
            Object.keys(this.files).forEach(function (k) {
                self.pool[k] = []; self.idx[k] = 0; self.ok[k] = false;
                for (var i = 0; i < 6; i++) {
                    var a = new Audio();
                    a.preload = "auto";
                    a.addEventListener("canplaythrough", function () { self.ok[k] = true; }, { once: true });
                    a.addEventListener("error", function () { self.ok[k] = false; }, { once: true });
                    a.src = self.files[k];
                    self.pool[k].push(a);
                }
            });
        },
        // override a sample from a decoded skin (Blob URL); replaces pooled <audio>
        setSample: function (k, url) {
            var self = this; self.pool[k] = []; self.idx[k] = 0; self.ok[k] = false;
            for (var i = 0; i < 6; i++) {
                var a = new Audio(); a.preload = "auto";
                a.addEventListener("canplaythrough", function () { self.ok[k] = true; }, { once: true });
                a.src = url; self.pool[k].push(a);
            }
        },
        play: function (kat, big, vol) {
            var k = kat ? "kat" : (big ? "bigdon" : "don");
            var p = this.pool[k];
            if (this.ok[k] && p && p.length) {
                var a = p[this.idx[k]]; this.idx[k] = (this.idx[k] + 1) % p.length;
                try { a.currentTime = 0; a.volume = Math.max(0, Math.min(1, vol)); a.play(); return; } catch (e) { }
            }
            drumSound(kat, big, vol); // synth fallback
        },
        comboBreak: null,
        playComboBreak: function (vol) {
            if (!this.comboBreak) { this.comboBreak = new Audio("hitsounds/combobreak.wav"); this.comboBreak.preload = "auto"; }
            try { this.comboBreak.currentTime = 0; this.comboBreak.volume = Math.max(0, Math.min(1, vol)); this.comboBreak.play(); } catch (e) { }
        }
    };

    // ============================================================ skin (.osk)
    var SKIN_ELEMENTS = [
        "taikohitcircle", "taikohitcircleoverlay", "taikobigcircle", "taikobigcircleoverlay",
        "taiko-roll-middle", "taiko-roll-end", "taiko-drum-inner", "taiko-drum-outer", "taiko-glow",
        // playfield bar + measure lines
        "taiko-bar-left", "taiko-bar-right", "taiko-bar-right-glow", "taiko-barline",
        // hit-judgement burst graphics
        "taiko-hit300", "taiko-hit300g", "taiko-hit300k", "taiko-hit100", "taiko-hit100k", "taiko-hit50", "taiko-hit0"
    ];
    // taiko skin file names that ship as bundled defaults (skin/taiko/*.png)
    var DEFAULT_SKIN_FILES = SKIN_ELEMENTS.slice();
    var Skin = {
        tex: {},   // overrides loaded from a user .osk
        def: {},   // bundled default skin (skin/taiko/*.png)
        has: function (n) { return !!(this.tex[n] || this.def[n]); },
        get: function (n) { return this.tex[n] || this.def[n]; },
        clear: function () { // clears only the .osk override, keeps defaults
            for (var k in this.tex) { try { this.tex[k].destroy(true); } catch (e) { } }
            this.tex = {};
        },
        // Load the bundled default skin. We prefer the embedded data URLs in
        // skindata.js: on file:// a plain <img src="skin/taiko/*.png"> taints the
        // WebGL canvas (each local file is its own origin), which makes PIXI's
        // texImage2D throw and blanks the whole game. Data URLs are same-origin
        // and never taint, so they work on both file:// and http(s).
        loadDefaults: function (done) {
            var self = this, pending = 0;
            var data = window.TAIKO_SKIN_DATA || {};
            function fin() { if (pending === 0 && done) done(); }
            DEFAULT_SKIN_FILES.forEach(function (name) {
                pending++;
                var img = new Image();
                img.onload = function () {
                    try { self.def[name] = PIXI.Texture.from(img); } catch (e) { }
                    pending--; fin();
                };
                img.onerror = function () { pending--; fin(); };
                img.src = data[name] || ("skin/taiko/" + name + ".png");
            });
            if (pending === 0) fin();
        },
        loadOsk: function (blob, done) {
            var self = this;
            self.clear();
            var fs = new zip.fs.FS();
            fs.root.importBlob(blob, function () {
                var entries = [];
                (function walk(node) {
                    if (!node.children) return;
                    node.children.forEach(function (c) { c.directory ? walk(c) : entries.push(c); });
                })(fs.root);
                var byName = {};
                entries.forEach(function (e) { byName[e.name.toLowerCase()] = e; });
                var pending = 0, found = 0;
                function fin() { if (pending === 0 && done) done(found); }
                SKIN_ELEMENTS.forEach(function (base) {
                    var entry = byName[base + "@2x.png"] || byName[base + ".png"];
                    if (!entry) return;
                    found++; pending++;
                    entry.getBlob("image/png", function (b) {
                        PIXI.Texture.fromURL(URL.createObjectURL(b)).then(function (tex) {
                            self.tex[base] = tex; pending--; fin();
                        }).catch(function () { pending--; fin(); });
                    });
                });
                fin();
            }, function () { if (done) done(0); });
        }
    };

    // ============================================================ taiko game
    var SND_WHISTLE = 2, SND_FINISH = 4, SND_CLAP = 8;
    var PLAYFIELD_HEIGHT = 200, HIT_TARGET_OFFSET = 130;
    var NOTE_R = 42, BIG_R = 63, SCROLL = 2.0;
    var BIG_HIT_WINDOW = 40; // ms to land the 2nd key for a big (finisher) note
    var PLAYFIELD_SCREEN_RATIO = 0.26, LANE_Y_RATIO = 0.26;
    var COLOR_DON = 0xf03434, COLOR_KAT = 0x3aa0e0, COLOR_ROLL = 0xf3c34a, COLOR_DENDEN = 0xf3a24a;

    function TaikoGame(app, parsed, audio, opts, onQuit) {
        var self = this;
        this.app = app;
        this.audio = audio;
        this.opts = opts;
        this.onQuit = onQuit;
        this.ended = false;
        this.paused = false;

        var mods = opts.mods || {};
        this.mods = mods;
        var diff = parsed.difficulty;
        var OD = diff.OverallDifficulty;
        if (mods.hr) OD = Math.min(10, OD * 1.4); else if (mods.ez) OD = OD * 0.5;
        // osu!taiko hit windows (TaikoHitWindows): Great 50/35/20, Ok 120/80/50 ms.
        this.GreatTime = difficultyRange(OD, 50, 35, 20);
        this.GoodTime = difficultyRange(OD, 120, 80, 50);
        var SliderMult = diff.SliderMultiplier;

        // score multiplier from mods (osu! values)
        this.scoreMult = 1.0;
        if (mods.ez) this.scoreMult *= 0.5;
        if (mods.hr) this.scoreMult *= 1.06;
        if (mods.ht) this.scoreMult *= 0.3;
        if (mods.dt) this.scoreMult *= 1.12;
        if (mods.hd) this.scoreMult *= 1.06;
        if (mods.nf) this.scoreMult *= 0.5;

        // build notes
        this.notes = [];
        parsed.hitObjects.forEach(function (h) {
            var n = { time: h.time, endTime: h.endTime, score: -1, finished: false };
            if (h.kind === "circle") {
                n.kind = "note";
                n.kat = !!(h.hitSound & (SND_WHISTLE | SND_CLAP));
                n.big = !!(h.hitSound & SND_FINISH);
            } else if (h.kind === "slider") {
                n.kind = "drumroll"; n.big = !!(h.hitSound & SND_FINISH);
            } else if (h.kind === "spinner") {
                n.kind = "denden";
                var dur = Math.max(1, h.endTime - h.time);
                n.required = Math.max(1, Math.floor(dur / 1000 * (3 + OD * 0.5)));
                n.count = 0;
            } else return;
            var mpb = (h.timing && h.timing.msPerBeat) || 500;
            n.velocity = SliderMult * 100 / mpb;
            if (n.velocity <= 0) n.velocity = 0.25;
            self.notes.push(n);
        });
        this.notes.sort(function (a, b) { return a.time - b.time; });

        this.firstTime = this.notes.length ? this.notes[0].time : 0;
        this.endTime = (this.notes.length ? this.notes[this.notes.length - 1].endTime : 0) + 1500;
        this.wait = Math.max(0, 1500 - this.firstTime);

        // measure barlines (osu!taiko draws a line at the start of every measure).
        // Spacing uses the real (uninherited) beat length; scroll speed uses the
        // effective beat length at that time so SV changes are respected.
        var allTP = parsed.timingPoints;
        function effMpb(t) {
            var m = allTP.length ? allTP[0].msPerBeat : 500;
            for (var i = 0; i < allTP.length; i++) { if (allTP[i].offset <= t) m = allTP[i].msPerBeat; else break; }
            return m;
        }
        this.barlines = []; this.barVel = [];
        var uTP = allTP.filter(function (p) { return p.uninherited === 1 && p.msPerBeat > 0; });
        for (var bi = 0; bi < uTP.length && this.barlines.length < 8000; bi++) {
            var measure = uTP[bi].msPerBeat * (uTP[bi].meter || 4);
            if (!(measure > 0)) continue;
            var segEnd = (bi + 1 < uTP.length) ? uTP[bi + 1].offset : this.endTime + 2000;
            for (var tm = uTP[bi].offset; tm < segEnd && this.barlines.length < 8000; tm += measure) {
                this.barlines.push(tm);
                this.barVel.push(SliderMult * 100 / effMpb(tm));
            }
        }
        this.barStart = 0;

        // kiai time ranges (taiko-bar-right-glow lights up the lane during kiai)
        this.kiaiRanges = [];
        var kon = -1;
        for (var ci = 0; ci < allTP.length; ci++) {
            if (allTP[ci].kiai && kon < 0) kon = allTP[ci].offset;
            else if (!allTP[ci].kiai && kon >= 0) { this.kiaiRanges.push([kon, allTP[ci].offset]); kon = -1; }
        }
        if (kon >= 0) this.kiaiRanges.push([kon, this.endTime + 5000]);

        // score state
        this.score = 0; this.combo = 0; this.maxcombo = 0;
        this.cnt = { great: 0, good: 0, miss: 0 };
        this.pendingBig = null;   // big note awaiting its 2nd key for the strong bonus
        this._bigJustHit = 0;     // points of a big note judged on the current input
        this.totalNotes = this.notes.filter(function (n) { return n.kind === "note"; }).length;

        // health (osu!taiko mode = lazer AccumulatingHealthProcessor): the gauge
        // starts EMPTY and accumulates as you hit. There is no mid-song fail; at
        // the end you CLEAR if the gauge is >= PASS_HP (0.5). Gains are normalised
        // to the note count so a full play fills it; misses drain (scaled by HP).
        var HPDrain = (diff.HPDrainRate === undefined) ? 5 : diff.HPDrainRate;
        if (mods.hr) HPDrain = Math.min(10, HPDrain * 1.4); else if (mods.ez) HPDrain = HPDrain * 0.5;
        var hpN = Math.max(1, this.totalNotes);
        this.hp = 0.0;
        this.PASS_HP = mods.nf ? 0 : 0.5;   // No Fail always clears
        this.HP_GREAT = 1.0 / hpN;
        this.HP_GOOD = 0.5 / hpN;
        this.HP_MISS = -(1.0 / hpN) * (0.5 + 0.1 * HPDrain);
        this.HP_TICK = 0.15 / hpN;
        this.failed = false;
        this.addHealth = function (d) { self.hp = clamp(self.hp + d, 0, 1); };

        // ---- display ----
        this.field = new PIXI.Container();
        this.noteLayer = new PIXI.Container();
        this.hitLayer = new PIXI.Container();
        this.staticC = new PIXI.Container();
        this.barLayer = new PIXI.Container();   // measure lines (below notes, above lane bg)
        this.barPool = [];
        this.field.addChild(this.staticC);
        this.field.addChild(this.barLayer);
        this.field.addChild(this.noteLayer);
        this.field.addChild(this.hitLayer);
        app.stage.addChild(this.field);

        // HUD (plain text, no atlas)
        this.hud = new PIXI.Container();
        app.stage.addChild(this.hud);
        function mkText(size, anchorX) {
            var t = new PIXI.Text("", { fontFamily: "Arial, sans-serif", fontSize: size, fill: 0xffffff, fontWeight: "bold", stroke: 0x000000, strokeThickness: 3 });
            t.anchor.set(anchorX, 0);
            return t;
        }
        this.scoreText = mkText(34, 1);
        this.comboText = mkText(26, 0);
        this.accText = mkText(22, 1);
        // HP gauge (drawn each frame in updateHpBar)
        this.hpBarBG = new PIXI.Graphics();
        this.hpBarFill = new PIXI.Graphics();
        this.hud.addChild(this.hpBarBG, this.hpBarFill, this.scoreText, this.comboText, this.accText);
        this.judgeText = new PIXI.Text("", { fontFamily: "Arial", fontSize: 28, fill: 0xffffff, fontWeight: "bold", stroke: 0x000000, strokeThickness: 4 });
        this.judgeText.anchor.set(0.5);
        this.judgeText.alpha = 0;
        this.field.addChild(this.judgeText);
        // skinned hit-judgement burst (taiko-hit*); falls back to judgeText when absent
        this.judgeSprite = new PIXI.Sprite();
        this.judgeSprite.anchor.set(0.5);
        this.judgeSprite.alpha = 0; this.judgeSprite.visible = false;
        this.judgeBaseScale = 1;
        this.field.addChild(this.judgeSprite);

        this.explosions = [];
        this.lastTime = -1e9;

        this.calcSize = function () {
            var W = app.renderer.width, H = app.renderer.height;
            self.scale = clamp(H * PLAYFIELD_SCREEN_RATIO / PLAYFIELD_HEIGHT, W / 2400, W / 700);
            self.virtualWidth = W / self.scale;
            self.laneY = H * LANE_Y_RATIO;
            self.field.scale.set(self.scale);
            self.field.x = 0; self.field.y = self.laneY;
            self.buildStatic();
            // HUD positions
            self.scoreText.position.set(W - 16, 10);
            self.accText.position.set(W - 16, 52);
            self.comboText.position.set(16, 10);
            self.judgeText.x = HIT_TARGET_OFFSET; self.judgeText.y = -PLAYFIELD_HEIGHT * 0.5 - 30;
            self.judgeSprite.x = HIT_TARGET_OFFSET; self.judgeSprite.y = 0;
            // HP gauge geometry (top-left, ~half width so it isn't full-screen)
            self.hpX = Math.max(150, W * 0.1); self.hpY = 12;
            self.hpH = 16; self.hpW = Math.max(120, W * 0.5);
            self.hpBarBG.clear();
            self.hpBarBG.beginFill(0x000000, 0.5).drawRoundedRect(self.hpX, self.hpY, self.hpW, self.hpH, 4).endFill();
            self.hpBarBG.lineStyle(2, 0xffffff, 0.35).drawRoundedRect(self.hpX, self.hpY, self.hpW, self.hpH, 4);
            // clear line at PASS_HP (50%)
            var clx = self.hpX + self.hpW * self.PASS_HP;
            self.hpBarBG.lineStyle(2, 0xffe066, 0.9).moveTo(clx, self.hpY - 2).lineTo(clx, self.hpY + self.hpH + 2);
            self.updateHpBar();
        };

        this.updateHpBar = function () {
            var col = self.hp > 0.5 ? 0x6ad06a : (self.hp > 0.25 ? 0xe0c14a : 0xe05050);
            self.hpBarFill.clear();
            if (self.hp > 0) {
                self.hpBarFill.beginFill(col, 0.95)
                    .drawRoundedRect(self.hpX + 2, self.hpY + 2, Math.max(0, (self.hpW - 4) * self.hp), self.hpH - 4, 3).endFill();
            }
        };

        this.buildStatic = function () {
            self.staticC.removeChildren().forEach(function (c) { c.destroy({ children: true }); });
            var laneH = PLAYFIELD_HEIGHT, W = self.virtualWidth;
            // scrolling lane (taiko-bar-right) runs from the hit target to the right
            if (Skin.has("taiko-bar-right")) {
                var br = new PIXI.Sprite(Skin.get("taiko-bar-right"));
                br.anchor.set(0, 0.5); br.x = HIT_TARGET_OFFSET; br.y = 0;
                br.width = Math.max(1, W - HIT_TARGET_OFFSET); br.height = laneH;
                self.staticC.addChild(br);
            } else {
                var gb = new PIXI.Graphics();
                gb.beginFill(0x000000, 0.55).drawRect(HIT_TARGET_OFFSET, -laneH / 2, W, laneH).endFill();
                self.staticC.addChild(gb);
            }
            // left input panel (taiko-bar-left) fills up to the hit target
            if (Skin.has("taiko-bar-left")) {
                var bl = new PIXI.Sprite(Skin.get("taiko-bar-left"));
                bl.anchor.set(0, 0.5); bl.x = 0; bl.y = 0; bl.width = HIT_TARGET_OFFSET; bl.height = laneH;
                self.staticC.addChild(bl);
            } else {
                var gl0 = new PIXI.Graphics();
                gl0.beginFill(0x1a1a1a, 0.85).drawRect(0, -laneH / 2, HIT_TARGET_OFFSET, laneH).endFill();
                self.staticC.addChild(gl0);
            }
            var g = new PIXI.Graphics();
            g.beginFill(0xffffff, 0.18).drawRect(0, -laneH / 2, W, 2).drawRect(0, laneH / 2 - 2, W, 2).endFill();
            self.staticC.addChild(g);
            // kiai glow overlay on the lane (faded in/out during kiai time)
            if (Skin.has("taiko-bar-right-glow")) {
                var kg = new PIXI.Sprite(Skin.get("taiko-bar-right-glow"));
                kg.anchor.set(0, 0.5); kg.x = HIT_TARGET_OFFSET; kg.y = 0;
                kg.width = Math.max(1, W - HIT_TARGET_OFFSET); kg.height = laneH;
                kg.alpha = 0; kg.blendMode = PIXI.BLEND_MODES.ADD;
                self.staticC.addChild(kg); self.kiaiGlow = kg;
            } else { self.kiaiGlow = null; }
            // Hit-target indicator: judgement frame only (the static taiko drum
            // graphic is intentionally hidden per skin layout).
            var ring = new PIXI.Graphics();
            ring.lineStyle(3, 0xffffff, 0.45).drawCircle(HIT_TARGET_OFFSET, 0, BIG_R + 2);
            ring.lineStyle(2, 0xffffff, 0.85).drawCircle(HIT_TARGET_OFFSET, 0, NOTE_R + 2);
            self.staticC.addChild(ring);
        };

        this.calcSize();

        // ---- notes ----
        this.makeNote = function (n) {
            var c = new PIXI.Container();
            if (n.kind === "note") {
                var r = n.big ? BIG_R : NOTE_R;
                var base = n.big ? "taikobigcircle" : "taikohitcircle";
                var ov = n.big ? "taikobigcircleoverlay" : "taikohitcircleoverlay";
                if (Skin.has(base)) {
                    var s = new PIXI.Sprite(Skin.get(base)); s.anchor.set(0.5);
                    s.scale.set(2 * r / s.texture.width); s.tint = n.kat ? COLOR_KAT : COLOR_DON; c.addChild(s);
                    if (Skin.has(ov)) { var o = new PIXI.Sprite(Skin.get(ov)); o.anchor.set(0.5); o.scale.set(2 * r / o.texture.width); c.addChild(o); }
                } else {
                    var g = new PIXI.Graphics();
                    g.lineStyle(4, 0xffffff, 0.9).beginFill(n.kat ? COLOR_KAT : COLOR_DON).drawCircle(0, 0, r).endFill();
                    g.lineStyle(0).beginFill(0xffffff, 0.22).drawCircle(0, 0, r * 0.45).endFill();
                    c.addChild(g);
                }
            } else if (n.kind === "drumroll") {
                var len = Math.max(0, (n.endTime - n.time) * n.velocity * SCROLL);
                var rr = n.big ? BIG_R : NOTE_R; n.bodyLen = len;
                if (Skin.has("taiko-roll-middle")) {
                    var mid = new PIXI.Sprite(Skin.get("taiko-roll-middle"));
                    mid.anchor.set(0, 0.5); mid.width = len; mid.height = 2 * rr; c.addChild(mid);
                    if (Skin.has("taiko-roll-end")) {
                        var e1 = new PIXI.Sprite(Skin.get("taiko-roll-end")); e1.anchor.set(0, 0.5); e1.height = 2 * rr; e1.scale.x = Math.abs(e1.scale.y); e1.x = len; c.addChild(e1);
                        var e0 = new PIXI.Sprite(Skin.get("taiko-roll-end")); e0.anchor.set(0, 0.5); e0.height = 2 * rr; e0.scale.x = -Math.abs(e0.scale.y); c.addChild(e0);
                    }
                } else {
                    var gr = new PIXI.Graphics();
                    gr.lineStyle(3, 0xffffff, 0.85).beginFill(COLOR_ROLL).drawCircle(0, 0, rr).drawRect(0, -rr, len, rr * 2).drawCircle(len, 0, rr).endFill();
                    c.addChild(gr);
                }
            } else { // denden (spinner): hit alternating don/kat the required number of times
                var gd = new PIXI.Graphics();
                gd.lineStyle(4, 0xffffff, 0.9).beginFill(COLOR_DENDEN).drawCircle(0, 0, BIG_R).endFill();
                gd.lineStyle(0).beginFill(0xffffff, 0.18).drawCircle(0, 0, BIG_R * 0.6).endFill();
                c.addChild(gd);
                var lbl = new PIXI.Text("" + Math.max(0, n.required - n.count), {
                    fontFamily: "Arial, sans-serif", fontSize: 40, fill: 0xffffff,
                    fontWeight: "bold", stroke: 0x000000, strokeThickness: 5
                });
                lbl.anchor.set(0.5); c.addChild(lbl); n.countLabel = lbl;
            }
            n.gfx = c; self.noteLayer.addChild(c); return c;
        };

        // No coloured frame flash on don/kat input (kept as a no-op so callers
        // and autoplay don't need to change).
        this.flashJudge = function (right, kat) { };
        this.popJudge = function (points, big) {
            var key, txt, color;
            if (points >= 300) { key = big ? "taiko-hit300g" : "taiko-hit300"; txt = "GREAT"; color = "#ffd966"; }
            else if (points >= 100) { key = "taiko-hit100"; txt = "GOOD"; color = "#88dd88"; }
            else { key = "taiko-hit0"; txt = "MISS"; color = "#dd5555"; }
            var tex = Skin.has(key) ? Skin.get(key)
                : (points >= 300 && Skin.has("taiko-hit300")) ? Skin.get("taiko-hit300") : null;
            if (tex) {
                self.judgeSprite.texture = tex;
                self.judgeSprite.height = PLAYFIELD_HEIGHT * 0.72;
                self.judgeSprite.scale.x = self.judgeSprite.scale.y;
                self.judgeBaseScale = self.judgeSprite.scale.y;
                self.judgeSprite.visible = true; self.judgeSprite.alpha = 1;
                self.judgeSprite._t0 = self.lastTime;
                self.judgeText.alpha = 0;
            } else {
                self.judgeSprite.visible = false;
                self.judgeText.text = txt; self.judgeText.style.fill = color;
                self.judgeText.alpha = 1; self.judgeText.scale.set(1);
                self.judgeText._t0 = self.lastTime;
            }
        };
        // No default ring effect: the skin's taiko-hit300/100 burst (popJudge)
        // provides the hit feedback, so the orange/green rings are intentionally off.
        this.spawnExplosion = function (n, points) { };

        this.addScore = function (points, addCombo) {
            if (addCombo) { this.combo++; this.maxcombo = Math.max(this.maxcombo, this.combo); }
            this.score += Math.round(points * (1 + this.combo / 25) * this.scoreMult);
        };
        this.breakCombo = function () {
            if (this.combo >= 20) Sound.playComboBreak(opts.effectVolume); // osu! plays combobreak at 20+
            this.combo = 0;
        };

        this.applyNote = function (n, points, diff) {
            n.score = points; n.finished = true;
            if (points >= 300) { this.cnt.great++; this.addScore(300, true); this.addHealth(this.HP_GREAT); this.popJudge(300, n.big); }
            else if (points >= 100) { this.cnt.good++; this.addScore(100, true); this.addHealth(this.HP_GOOD); this.popJudge(100); }
            else { this.cnt.miss++; this.breakCombo(); this.addHealth(this.HP_MISS); this.popJudge(0); }
            if (points > 0) { this.spawnExplosion(n, points); n.fadeOut = this.lastTime; }
            this._bigJustHit = (n.big && points > 0) ? points : 0;
        };

        this.judgeInput = function (kat, time) {
            for (var i = 0; i < self.notes.length; i++) {
                var n = self.notes[i];
                if (n.kind === "note") {
                    if (n.score >= 0) continue;
                    var d = time - n.time;
                    if (d < -self.GoodTime) break;
                    if (d > self.GoodTime) continue;
                    if (n.kat !== kat) return;
                    self.applyNote(n, Math.abs(d) <= self.GreatTime ? 300 : 100, d);
                    return;
                } else if (n.kind === "drumroll") {
                    if (time >= n.time && time <= n.endTime) { self.score += 200; self.addHealth(self.HP_TICK); self.spawnExplosion(n, 300); return; }
                    if (time < n.time) break;
                } else if (n.kind === "denden") {
                    if (time >= n.time && time <= n.endTime && !n.finished) {
                        if (n.lastKat === undefined || n.lastKat !== kat) {
                            n.count++; n.lastKat = kat; self.score += 150; self.addHealth(self.HP_TICK);
                            if (n.count >= n.required) {
                                n.finished = true; n.score = 300; self.score += 1000;
                                self.addHealth(self.HP_GREAT); self.spawnExplosion(n, 300); n.fadeOut = time;
                            }
                        }
                        return;
                    }
                    if (time < n.time) break;
                }
            }
        };

        // ---- input ----
        this.keyDown = {};
        this.onKeyDown = function (e) {
            if (self.paused || self.ended) {
                if (e.keyCode === 27) { e.preventDefault(); self.togglePause(); }
                return;
            }
            var code = e.keyCode;
            if (code === 27) { e.preventDefault(); self.togglePause(); return; }
            if (self.keyDown[code]) return;
            var k = opts.keys, matched = true, kat = false, right = false;
            if (code === k.donL) { kat = false; right = false; }
            else if (code === k.donR) { kat = false; right = true; }
            else if (code === k.katL) { kat = true; right = false; }
            else if (code === k.katR) { kat = true; right = true; }
            else matched = false;
            if (!matched) return;
            self.keyDown[code] = true;
            e.preventDefault();
            self.hit(kat, right);
        };
        this.onKeyUp = function (e) { self.keyDown[e.keyCode] = false; };
        this.onTouch = function (e) {
            if (self.paused || self.ended) return;
            if (!e.changedTouches) return;
            e.preventDefault();
            var W = window.innerWidth, H = window.innerHeight, cy = H * LANE_Y_RATIO, band = H * 0.18;
            for (var i = 0; i < e.changedTouches.length; i++) {
                var tc = e.changedTouches[i];
                var right = tc.clientX > W / 2;
                var kat = Math.abs(tc.clientY - cy) > band;
                self.hit(kat, right);
            }
        };
        this.hit = function (kat, right) {
            ensureAudio();
            var time = self.audio.started ? self.audio.getMs() : 0;
            self.flashJudge(right, kat);
            Sound.play(kat, false, opts.effectVolume);
            if (opts.autoplay) return;
            // strong (big) note: the 2nd key of the same colour, on the other side
            // and within the window, doubles the note's score (osu!taiko finisher)
            var pb = self.pendingBig;
            if (pb && !pb.bigBonusGiven && time <= pb.bigUntil && kat === pb.bigKat && right !== pb.bigRight) {
                pb.bigBonusGiven = true; self.pendingBig = null;
                self.score += Math.round(pb.bigPoints * (1 + self.combo / 25) * self.scoreMult);
                self.addHealth(self.HP_TICK);
                return;
            }
            self._bigJustHit = 0;
            self.judgeInput(kat, time);
            if (self._bigJustHit > 0) {
                self.pendingBig = { bigKat: kat, bigRight: right, bigUntil: time + BIG_HIT_WINDOW, bigPoints: self._bigJustHit, bigBonusGiven: false };
                self._bigJustHit = 0;
            }
        };

        window.addEventListener("keydown", this.onKeyDown);
        window.addEventListener("keyup", this.onKeyUp);
        window.addEventListener("touchstart", this.onTouch, { passive: false });

        // ---- autoplay ----
        this.autoIndex = 0;
        this.updateAuto = function (time) {
            while (self.autoIndex < self.notes.length) {
                var n = self.notes[self.autoIndex];
                if (n.kind === "note") {
                    if (time >= n.time) {
                        self.applyNote(n, 300, 0);
                        if (self._bigJustHit > 0) { self.score += Math.round(self._bigJustHit * (1 + self.combo / 25) * self.scoreMult); self._bigJustHit = 0; }
                        self.flashJudge(false, n.kat); if (n.big) self.flashJudge(true, n.kat);
                        Sound.play(n.kat, n.big, opts.effectVolume);
                        self.autoIndex++;
                    } else break;
                } else if (n.kind === "drumroll") {
                    if (time >= n.endTime) self.autoIndex++;
                    else if (time >= n.time) {
                        if (!n.lastAuto || time - n.lastAuto > 60) { n.lastAuto = time; self.score += 200; self.addHealth(self.HP_TICK); self.flashJudge(false, false); Sound.play(false, false, opts.effectVolume); self.spawnExplosion(n, 300); }
                        break;
                    } else break;
                } else {
                    if (time >= n.endTime) self.autoIndex++;
                    else if (time >= n.time) {
                        if (!n.finished && (!n.lastAuto || time - n.lastAuto > 60)) { n.lastAuto = time; n.count++; n.lastKat = !n.lastKat; self.score += 150; self.addHealth(self.HP_TICK); if (n.count >= n.required) { n.finished = true; n.score = 300; self.score += 1000; self.spawnExplosion(n, 300); n.fadeOut = time; } self.flashJudge(false, !!n.lastKat); Sound.play(!!n.lastKat, false, opts.effectVolume); }
                        break;
                    } else break;
                }
            }
        };

        // ---- barlines ----
        this.makeBarline = function () {
            var s;
            if (Skin.has("taiko-barline")) {
                s = new PIXI.Sprite(Skin.get("taiko-barline"));
                s.anchor.set(0.5, 0.5); s.height = PLAYFIELD_HEIGHT; s.scale.x = s.scale.y; s.alpha = 0.55;
            } else {
                s = new PIXI.Graphics();
                s.beginFill(0xffffff, 0.25).drawRect(-1, -PLAYFIELD_HEIGHT / 2, 2, PLAYFIELD_HEIGHT).endFill();
            }
            self.barLayer.addChild(s); return s;
        };
        this.renderBarlines = function (time, W) {
            function bx(idx) { return HIT_TARGET_OFFSET + (self.barlines[idx] - time) * self.barVel[idx] * SCROLL; }
            while (self.barStart < self.barlines.length && bx(self.barStart) < -60) self.barStart++;
            var used = 0;
            for (var b = self.barStart; b < self.barlines.length; b++) {
                var px = bx(b);
                if (px > W + 60) break;
                var spr = self.barPool[used] || (self.barPool[used] = self.makeBarline());
                spr.visible = true; spr.x = px; spr.y = 0;
                used++;
            }
            for (var u = used; u < self.barPool.length; u++) self.barPool[u].visible = false;
        };

        // ---- per-frame ----
        this.render = function () {
            if (self.paused || self.ended) return;
            var time = self.audio.started ? self.audio.getMs() : -self.wait - 800;
            self.lastTime = time;
            if (opts.autoplay) self.updateAuto(time);

            var W = self.virtualWidth, spawnAhead = W + 200;
            self.renderBarlines(time, W);
            if (self.kiaiGlow) {
                var inK = false;
                for (var ki = 0; ki < self.kiaiRanges.length; ki++) {
                    if (time >= self.kiaiRanges[ki][0] && time < self.kiaiRanges[ki][1]) { inK = true; break; }
                }
                self.kiaiGlow.alpha += ((inK ? 0.6 : 0) - self.kiaiGlow.alpha) * 0.15;
            }
            for (var i = 0; i < self.notes.length; i++) {
                var n = self.notes[i];
                if (n.kind === "note" && n.score < 0 && time - n.time > self.GoodTime) {
                    n.score = 0; n.finished = true; self.cnt.miss++; self.breakCombo(); self.addHealth(self.HP_MISS); self.popJudge(0);
                }
                var x = HIT_TARGET_OFFSET + (n.time - time) * n.velocity * SCROLL;
                if (n.kind === "denden") {
                    // keep the denden pinned on the hit target while it is active so
                    // it can't scroll past before you finish the required hits
                    if (time >= n.time && time <= n.endTime) x = HIT_TARGET_OFFSET;
                    else if (time > n.endTime) x = HIT_TARGET_OFFSET + (n.endTime - time) * n.velocity * SCROLL;
                    if (n.countLabel && !n.finished) n.countLabel.text = "" + Math.max(0, n.required - n.count);
                }
                var tailX = (n.kind === "drumroll") ? HIT_TARGET_OFFSET + (n.endTime - time) * n.velocity * SCROLL : x;
                var visible = (x < spawnAhead) && (tailX > -200);
                if (n.fadeOut !== undefined && time - n.fadeOut > 150) visible = false;
                if (visible) {
                    if (!n.gfx) self.makeNote(n);
                    n.gfx.x = x; n.gfx.y = 0;
                    if (n.fadeOut !== undefined) {
                        var f = (time - n.fadeOut) / 150;
                        n.gfx.alpha = Math.max(0, 1 - f); n.gfx.y = -f * 80; n.gfx.scale.set(1 + f * 0.3);
                    } else if (mods.hd && n.kind !== "denden") {
                        // Hidden: notes fade out as they approach the hit target
                        var fs = HIT_TARGET_OFFSET + W * 0.45;
                        n.gfx.alpha = clamp((x - HIT_TARGET_OFFSET) / (fs - HIT_TARGET_OFFSET), 0, 1);
                    } else {
                        n.gfx.alpha = 1;
                    }
                } else if (n.gfx) { self.noteLayer.removeChild(n.gfx); n.gfx.destroy({ children: true }); n.gfx = null; }
            }
            // explosions
            for (var e = self.explosions.length - 1; e >= 0; e--) {
                var g = self.explosions[e], ff = (time - g.t0) / 200;
                if (ff >= 1) { self.hitLayer.removeChild(g); g.destroy(); self.explosions.splice(e, 1); }
                else { g.alpha = 1 - ff; g.scale.set(1 + ff * 0.6); }
            }
            // judge text fade
            if (self.judgeText.alpha > 0) {
                var jt = (time - (self.judgeText._t0 || 0)) / 400;
                self.judgeText.alpha = Math.max(0, 1 - jt); self.judgeText.scale.set(1 + jt * 0.4);
            }
            // judge sprite (skin burst) pop + fade
            if (self.judgeSprite.visible && self.judgeSprite.alpha > 0) {
                var js = (time - (self.judgeSprite._t0 || 0)) / 450;
                self.judgeSprite.alpha = Math.max(0, 1 - js);
                self.judgeSprite.scale.set(self.judgeBaseScale * (1 + Math.min(js, 1) * 0.25));
                if (js >= 1) self.judgeSprite.visible = false;
            }
            // HUD
            self.scoreText.text = ("" + Math.round(self.score)).padStart(7, "0");
            self.comboText.text = self.combo + "x";
            var judged = self.cnt.great + self.cnt.good + self.cnt.miss;
            var acc = judged ? (self.cnt.great * 300 + self.cnt.good * 100) / (judged * 300) : 1;
            self.accText.text = (acc * 100).toFixed(2) + "%";
            self.updateHpBar();

            // osu!taiko clear check: gauge must reach the clear line at the end.
            // No mid-song fail (accumulating gauge).
            if (time > self.endTime && !self.ended) self.finish(acc, self.hp < self.PASS_HP);
        };

        // ---- pause ----
        this.togglePause = function () {
            if (self.ended) return;
            if (self.paused) { self.paused = false; self.audio.resume(); $("pausebox").style.display = "none"; }
            else { self.paused = true; self.audio.suspend(); $("pausebox").style.display = "flex"; }
        };

        // ---- end ----
        this.finish = function (acc, failed) {
            self.ended = true;
            self.failed = !!failed;
            self.audio.stop();
            var rank = failed ? "F"
                : acc >= 1 ? "SS" : acc >= 0.95 ? "S" : acc >= 0.9 ? "A" : acc >= 0.8 ? "B" : acc >= 0.7 ? "C" : "D";
            var box = $("resultbox");
            var meta = parsed.metadata || {};
            var gr = box.querySelector(".r-grade");
            gr.textContent = rank; gr.className = "g-grade r-grade " + rank;
            box.querySelector(".r-title").textContent = meta.Title || "";
            box.querySelector(".r-artist").textContent = meta.Artist || "";
            box.querySelector(".r-version").textContent = meta.Version || "";
            box.querySelector(".r-mapper").textContent = meta.Creator ? ("mapped by " + meta.Creator) : "";
            box.querySelector(".r-mods").textContent = modsText(self.mods);
            box.querySelector(".r-score").textContent = ("" + Math.round(self.score)).padStart(7, "0");
            box.querySelector(".r-acc").textContent = (acc * 100).toFixed(2) + "%";
            box.querySelector(".r-combo").textContent = self.maxcombo + "x";
            box.querySelector(".r-great").textContent = self.cnt.great;
            box.querySelector(".r-good").textContent = self.cnt.good;
            box.querySelector(".r-miss").textContent = self.cnt.miss;
            var fc = box.querySelector(".r-fullcombo");
            fc.style.display = (!failed && self.cnt.miss === 0 && (self.cnt.great + self.cnt.good) > 0) ? "block" : "none";
            box.style.display = "flex";
        };

        this.resize = function () { self.calcSize(); };
        this.destroy = function () {
            window.removeEventListener("keydown", self.onKeyDown);
            window.removeEventListener("keyup", self.onKeyUp);
            window.removeEventListener("touchstart", self.onTouch);
            self.audio.stop();
            app.stage.removeChild(self.field); self.field.destroy({ children: true });
            app.stage.removeChild(self.hud); self.hud.destroy({ children: true });
        };
    }

    // ============================================================ app shell
    var app, currentGame = null, currentSkinBlob = null;

    function showScreen(which) {
        $("menu").style.display = which === "menu" ? "block" : "none";
        $("game").style.display = which === "game" ? "block" : "none";
    }

    function readKeys() {
        function code(id, dflt) {
            var v = parseInt($(id).getAttribute("data-code"), 10);
            return isNaN(v) ? dflt : v;
        }
        return { katL: code("key-katL", 68), donL: code("key-donL", 70), donR: code("key-donR", 74), katR: code("key-katR", 75) };
    }

    function buildApp() {
        if (app) return;
        app = new PIXI.Application({ resizeTo: window, backgroundColor: 0x111111, antialias: true });
        $("game").appendChild(app.view);
        app.ticker.add(function () { if (currentGame) currentGame.render(); });
        window.addEventListener("resize", function () { if (currentGame) currentGame.resize(); });
    }

    // ---- small helpers ----
    function esc(s) {
        return String(s).replace(/[&<>"]/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
        });
    }
    function busy(show, text) {
        var b = $("busy");
        if (text && b.firstElementChild) b.firstElementChild.textContent = text;
        b.style.display = show ? "flex" : "none";
    }

    // unzip an .osz Blob and list its osu!taiko difficulties
    function openArchive(blob, name) {
        Preview.stop();
        var card = $("difflist-card");
        card.style.display = "block";
        $("difflist").innerHTML = "<div class='hint'>Reading " + esc(name || "beatmap") + " …</div>";
        var fs = new zip.fs.FS();
        fs.root.importBlob(blob, function () {
            var entries = [];
            (function walk(node) { if (node.children) node.children.forEach(function (c) { c.directory ? walk(c) : entries.push(c); }); })(fs.root);
            var osuFiles = entries.filter(function (e) { return /\.osu$/i.test(e.name); });
            if (!osuFiles.length) { $("difflist").innerHTML = "<div class='hint'>No .osu files in this archive.</div>"; return; }
            var pending = osuFiles.length, tracks = [];
            osuFiles.forEach(function (e) {
                e.getText(function (text) {
                    try {
                        var parsed = parseOsu(text);
                        if (Number(parsed.general.Mode) === 1) tracks.push(parsed);
                    } catch (err) { console.error("parse failed", e.name, err); }
                    if (--pending === 0) showDiffs(tracks, entries);
                });
            });
        }, function () { $("difflist").innerHTML = "<div class='hint'>Not a valid .osz file.</div>"; });
    }

    function showDiffs(tracks, entries) {
        var card = $("difflist-card"); card.style.display = "block";
        if (!tracks.length) { $("difflist").innerHTML = "<div class='hint'>This beatmap has no osu!taiko (Mode 2) difficulties.</div>"; return; }
        tracks.sort(function (a, b) { return a.difficulty.OverallDifficulty - b.difficulty.OverallDifficulty; });
        var html = "";
        tracks.forEach(function (t, i) {
            var m = t.metadata;
            html += "<button class='diff' data-i='" + i + "'><b>" + esc(m.Version || "?") + "</b>" +
                "<span>" + esc((m.Artist || "") + " - " + (m.Title || "")) + " &nbsp;|&nbsp; OD" + t.difficulty.OverallDifficulty + "</span></button>";
        });
        $("difflist").innerHTML = html;
        Array.prototype.forEach.call($("difflist").querySelectorAll(".diff"), function (btn) {
            btn.onclick = function () { play(tracks[+btn.getAttribute("data-i")], entries); };
        });
        card.scrollIntoView({ behavior: "smooth", block: "nearest" });
        startPreview(tracks, entries);
    }

    function play(parsed, entries) {
        Preview.stop();
        // find audio file
        var audioName = (parsed.general.AudioFilename || "").toLowerCase();
        var audioEntry = entries.filter(function (e) { return e.name.toLowerCase() === audioName; })[0];
        if (!audioEntry) { alert("Audio file not found in archive: " + audioName); return; }
        busy(true, "Loading audio…");
        audioEntry.getBlob("audio/mpeg", function (blob) {
            blob.arrayBuffer().then(function (ab) {
                decodeAudio(ab).then(function (buffer) {
                    busy(false);
                    startGame(parsed, entries, buffer);
                }).catch(function (err) { busy(false); alert("Could not decode audio: " + err); });
            });
        });
    }

    function startGame(parsed, entries, buffer) {
        ensureAudio();
        buildApp();
        $("settings").style.display = "none"; // hide settings during play
        showScreen("game");
        // background image
        setBackground(parsed, entries);

        var opts = {
            keys: readKeys(),
            autoplay: $("opt-autoplay").checked,
            masterVolume: parseFloat($("opt-volume").value) / 100,
            effectVolume: parseFloat($("opt-effect").value) / 100,
            mods: Object.assign({}, Mods),
            rate: modRate()
        };
        var audio = new AudioPlayer(buffer, opts.masterVolume, opts.rate);
        currentGame = new TaikoGame(app, parsed, audio, opts, backToMenu);

        // wire pause/result buttons
        $("pause-resume").onclick = function () { currentGame.togglePause(); };
        $("pause-retry").onclick = function () { var p = parsed, en = entries, bf = buffer; quitGame(); startGame(p, en, bf); };
        $("pause-quit").onclick = function () { quitGame(); backToMenu(); };
        $("result-retry").onclick = function () { var p = parsed, en = entries, bf = buffer; quitGame(); startGame(p, en, bf); };
        $("result-quit").onclick = function () { quitGame(); backToMenu(); };

        // lead-in then start audio
        var leadIn = 800 + currentGame.wait;
        setTimeout(function () { if (currentGame && !currentGame.ended) audio.start(leadIn); }, 50);
    }

    function setBackground(parsed, entries) {
        var bgName = null;
        for (var i = 0; i < parsed.events.length; i++) {
            var ev = parsed.events[i];
            if ((ev[0] === "0" || ev[0] === "Background") && ev[2]) { bgName = ev[2].replace(/^"|"$/g, ""); break; }
        }
        var div = $("game");
        div.style.backgroundImage = "";
        if (bgName) {
            var ent = entries.filter(function (e) { return e.name.toLowerCase() === bgName.toLowerCase(); })[0];
            if (ent) ent.getBlob("image/jpeg", function (b) { div.style.backgroundImage = "url(" + URL.createObjectURL(b) + ")"; });
        }
    }

    function quitGame() {
        if (currentGame) { currentGame.destroy(); currentGame = null; }
        $("pausebox").style.display = "none";
        $("resultbox").style.display = "none";
    }
    function backToMenu() { quitGame(); showScreen("menu"); }

    // ============================================================ online (sayobot)
    var onlineState = { offset: 0, loading: false };

    function listUrl(mode, offset, keyword) {
        var base = (window.BEATMAP_PROVIDER && BEATMAP_PROVIDER.API_LIST) || "https://api.sayobot.cn/beatmaplist";
        // 5 = mode filter (1=std, 2=taiko, 4=ctb, 8=mania). Limit to taiko only.
        var u = base + "?0=20&1=" + offset + "&2=" + mode + "&5=2";
        if (mode === "4" && keyword) u += "&3=" + encodeURIComponent(keyword);
        return u;
    }
    function coverUrl(sid) {
        return (typeof getCoverUrl === "function") ? getCoverUrl(sid)
            : "https://cdn.sayobot.cn:25225/beatmaps/" + sid + "/covers/cover.webp";
    }
    function dlUrl(sid) {
        return (typeof getDownloadUrl === "function") ? getDownloadUrl(sid)
            : "https://txy1.sayobot.cn/beatmaps/download/mini/" + sid;
    }

    function loadOnline(reset) {
        if (onlineState.loading) return;
        var mode = $("online-mode").value;
        var keyword = $("search-input").value.trim();
        if (mode === "4" && !keyword) { $("online-list").innerHTML = "<div class='hint'>Type a search keyword.</div>"; return; }
        if (reset) { onlineState.offset = 0; $("online-list").innerHTML = ""; $("online-more").style.display = "none"; }
        onlineState.loading = true;
        var hint = document.createElement("div"); hint.className = "hint"; hint.textContent = "Loading…";
        $("online-list").appendChild(hint);
        fetch(listUrl(mode, onlineState.offset, keyword)).then(function (r) { return r.json(); }).then(function (res) {
            hint.remove();
            var data = (res && res.data) || [];
            var taiko = data.filter(function (s) { return (s.modes & 2) !== 0; });
            if (!taiko.length && onlineState.offset === 0)
                $("online-list").innerHTML = "<div class='hint'>No osu!taiko beatmaps found here.</div>";
            taiko.forEach(addSetCard);
            onlineState.offset += 20;
            onlineState.loading = false;
            $("online-more").style.display = data.length >= 20 ? "block" : "none";
        }).catch(function (err) {
            hint.remove(); onlineState.loading = false;
            console.error(err);
            var e = document.createElement("div"); e.className = "hint";
            e.textContent = "Could not reach the beatmap server (offline or temporarily down). Try again.";
            $("online-list").appendChild(e);
        });
    }

    function addSetCard(set) {
        var card = document.createElement("div"); card.className = "setcard";
        var img = document.createElement("img"); img.loading = "lazy"; img.src = coverUrl(set.sid);
        img.onerror = function () { img.style.visibility = "hidden"; };
        var meta = document.createElement("div"); meta.className = "meta";
        meta.innerHTML = "<div class='t'>" + esc(set.title || "") + "</div>" +
            "<div class='a'>" + esc(set.artist || "") + "</div>" +
            "<div class='c'>mapped by " + esc(set.creator || "") + "</div>";
        var dl = document.createElement("div"); dl.className = "dl";
        card.appendChild(img); card.appendChild(meta); card.appendChild(dl);
        card.onclick = function () { downloadSet(set, dl); };
        $("online-list").appendChild(card);
    }

    function downloadSet(set, dlbar) {
        busy(true, "Downloading " + (set.title || set.sid) + " …");
        fetch(dlUrl(set.sid)).then(function (resp) {
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            var total = +resp.headers.get("content-length") || 0;
            if (!resp.body || !total) return resp.blob();
            var reader = resp.body.getReader(), chunks = [], loaded = 0;
            return (function pump() {
                return reader.read().then(function (r) {
                    if (r.done) return new Blob(chunks);
                    chunks.push(r.value); loaded += r.value.length;
                    if (dlbar) dlbar.style.width = (loaded / total * 100) + "%";
                    busy(true, "Downloading… " + Math.round(loaded / total * 100) + "%");
                    return pump();
                });
            })();
        }).then(function (blob) {
            busy(false);
            if (dlbar) dlbar.style.width = "100%";
            openArchive(blob, set.title || ("" + set.sid));
        }).catch(function (err) {
            busy(false);
            console.error(err);
            alert("Download failed: " + err.message + "\n(The beatmap provider may be busy — please try again.)");
        });
    }

    // ============================================================ init UI
    function init() {
        showScreen("menu");

        // load bundled default skin + sounds (osu!-named, .osk can override)
        Skin.loadDefaults(function () { console.log("[taiko] default skin ready"); });
        Sound.init();

        // settings panel
        $("settings-open").onclick = function () { $("settings").style.display = "block"; };
        $("settings-close").onclick = function () { $("settings").style.display = "none"; };
        $("settings").onclick = function (e) { if (e.target === $("settings")) $("settings").style.display = "none"; };

        // mods screen
        $("mods-open").onclick = function () { refreshModButtons(); $("modscreen").style.display = "flex"; };
        $("mods-close").onclick = function () { $("modscreen").style.display = "none"; };
        $("modscreen").onclick = function (e) { if (e.target === $("modscreen")) $("modscreen").style.display = "none"; };
        Array.prototype.forEach.call(document.querySelectorAll(".modbtn"), function (btn) {
            btn.onclick = function () { toggleMod(btn.getAttribute("data-mod")); refreshModButtons(); };
        });

        // online browsing
        $("online-mode").onchange = function () {
            $("search-input").style.display = this.value === "4" ? "block" : "none";
            if (this.value !== "4") loadOnline(true);
        };
        $("online-load").onclick = function () { loadOnline(true); };
        $("online-more").onclick = function () { loadOnline(false); };
        $("search-input").addEventListener("keydown", function (e) { if (e.key === "Enter") loadOnline(true); });
        loadOnline(true); // auto-load Popular

        // local file
        $("oszinput").onchange = function () { if (this.files[0]) openArchive(this.files[0], this.files[0].name); };
        $("oszbutton").onclick = function () { $("oszinput").click(); };

        // skin
        $("oskinput").onchange = function () {
            var f = this.files[0]; if (!f) return;
            $("skinstatus").textContent = "Loading skin...";
            Skin.loadOsk(f, function (found) {
                $("skinstatus").textContent = found ? ("Skin loaded (" + found + " elements).") : "No taiko elements found.";
            });
        };
        $("oskbutton").onclick = function () { $("oskinput").click(); };
        $("skinreset").onclick = function () { Skin.clear(); $("skinstatus").textContent = "Default skin (built-in)."; };

        // key rebinding
        Array.prototype.forEach.call(document.querySelectorAll(".keybtn"), function (btn) {
            btn.onclick = function () {
                btn.classList.add("listening"); btn.textContent = "press a key...";
                var handler = function (e) {
                    e.preventDefault();
                    btn.setAttribute("data-code", e.keyCode);
                    btn.textContent = keyName(e);
                    btn.classList.remove("listening");
                    window.removeEventListener("keydown", handler, true);
                };
                window.addEventListener("keydown", handler, true);
            };
        });

        // drag & drop onto the page
        window.addEventListener("dragover", function (e) { e.preventDefault(); });
        window.addEventListener("drop", function (e) {
            e.preventDefault();
            var f = e.dataTransfer.files[0]; if (!f) return;
            if (/\.osk$/i.test(f.name)) { Skin.loadOsk(f, function (n) { $("skinstatus").textContent = n ? ("Skin loaded (" + n + ").") : "No taiko elements."; }); }
            else if (/\.(osz|zip)$/i.test(f.name)) openArchive(f, f.name);
        });
    }

    function keyName(e) {
        if (e.key === " ") return "SPACE";
        if (e.key.length === 1) return e.key.toUpperCase();
        return e.key;
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();
