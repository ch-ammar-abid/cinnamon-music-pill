const Desklet = imports.ui.desklet;
const St = imports.gi.St;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const Clutter = imports.gi.Clutter;
const Pango = imports.gi.Pango;
const Settings = imports.ui.settings;

function unpack(v) {
    if (v === null || v === undefined) return v;
    try {
        if (v instanceof GLib.Variant) return unpack(v.deep_unpack());
    } catch (e) {}
    if (Array.isArray(v)) return v.map(unpack);
    if (typeof v === "object") {
        let out = {};
        for (let k in v) out[k] = unpack(v[k]);
        return out;
    }
    return v;
}

function firstString(v) {
    v = unpack(v);
    if (v === null || v === undefined) return "";
    if (Array.isArray(v)) return v.length ? String(v[0]) : "";
    return String(v);
}

function numberValue(v) {
    v = unpack(v);
    let n = Number(v);
    return isFinite(n) ? n : 0;
}

function fmtTime(us) {
    let sec = Math.max(0, Math.floor(numberValue(us) / 1000000));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function CinnamonMusicPillDesklet(metadata, instanceId) { this._init(metadata, instanceId); }

CinnamonMusicPillDesklet.prototype = {
    __proto__: Desklet.Desklet.prototype,

    _init: function(metadata, instanceId) {
        Desklet.Desklet.prototype._init.call(this, metadata, instanceId);
        this.settings = new Settings.DeskletSettings(this, metadata.uuid, instanceId);
        this.settings.bind("size", "size", this._rebuild.bind(this));
        this.settings.bind("opacity", "opacity", this._rebuild.bind(this));
        this.settings.bind("scale", "scale", this._rebuild.bind(this));
        this.settings.bind("fixed-height", "fixedHeight", this._rebuild.bind(this));
        this.settings.bind("accent", "accent", this._rebuild.bind(this));
        this.settings.bind("show-artwork", "showArtwork", this._rebuild.bind(this));
        this.settings.bind("show-progress", "showProgress", this._rebuild.bind(this));
        this.settings.bind("player-mode", "playerMode", this._refreshPlayers.bind(this));
        this.settings.bind("preferred-player", "preferredPlayer", this._refreshPlayers.bind(this));

        this._busName = null;
        this._playerProxy = null;
        this._propsProxy = null;
        this._propsSignal = 0;
        this._nameOwnerSignal = 0;
        this._positionTimer = 0;
        this._metadata = {};
        this._status = "No MPRIS player detected";
        this._position = 0;
        this._destroyed = false;
        this._toggleBusy = false;

        this._buildUi();
        this._subscribeBus();
        this._refreshPlayers();
    },

    _buildUi: function() {
        if (this._root) this._root.destroy();

        let mini = this.size === "mini";
        let wide = this.size === "large";
        let factor = clamp(numberValue(this.scale) / 100, 0.60, 2.00);
        let baseWidth = mini ? 300 : (wide ? 460 : 400);
        let baseArtSize = mini ? 62 : (wide ? 112 : 92);
        let width = Math.round(baseWidth * factor);
        let artSize = Math.round(baseArtSize * factor);

        this._root = new St.BoxLayout({
            vertical: false,
            style_class: "music-widget",
            reactive: true,
            width: width
        });
        this._root.set_width(width);
        let fixedHeight = Math.round(numberValue(this.fixedHeight));
        if (fixedHeight > 0) this._root.set_height(fixedHeight);
        this._root.set_style("background-color: rgba(10,10,18," + clamp(this.opacity, 0.20, 1) + ");");
        this.setContent(this._root);

        if (this.showArtwork) {
            // Fixed-size wrapper prevents MPRIS album art from using its native pixel size.
            this._artBox = new St.Bin({
                width: artSize,
                height: artSize,
                style_class: "music-art-box"
            });
            this._art = new St.Icon({
                icon_name: "audio-x-generic",
                icon_type: St.IconType.FULLCOLOR,
                icon_size: artSize,
                style_class: "music-art"
            });
            this._art.set_size(artSize, artSize);
            this._artBox.set_child(this._art);
            this._root.add_child(this._artBox);
        } else {
            this._artBox = null;
            this._art = null;
        }

        let body = new St.BoxLayout({vertical: true, style_class: "music-body"});
        body.set_x_expand(true);
        body.set_y_expand(true);
        this._root.add_child(body);

        let text = new St.BoxLayout({vertical: true, style_class: "music-text"});
        text.set_x_expand(true);

        this._title = new St.Label({text: "No music playing", style_class: "music-title"});
        this._artist = new St.Label({text: "", style_class: "music-artist"});
        this._album = new St.Label({text: "", style_class: "music-album"});
        this._setEllipsis(this._title);
        this._setEllipsis(this._artist);
        this._setEllipsis(this._album);

        text.add_child(this._title);
        text.add_child(this._artist);
        if (!mini) text.add_child(this._album);
        body.add_child(text);

        if (this.showProgress) {
            let times = new St.BoxLayout({vertical: false, style_class: "music-times"});
            this._elapsed = new St.Label({text: "0:00", style_class: "music-time"});
            this._remaining = new St.Label({text: "0:00", style_class: "music-time"});
            this._remaining.set_x_expand(true);
            this._remaining.set_x_align(Clutter.ActorAlign.END);
            times.add_child(this._elapsed);
            times.add_child(this._remaining);
            body.add_child(times);

            this._progress = new St.BoxLayout({vertical: false, style_class: "music-progress"});
            this._progressFill = new St.BoxLayout({vertical: false, style_class: "music-progress-fill"});
            this._progressFill.set_width(1);
            this._progress.add_child(this._progressFill);
            body.add_child(this._progress);
        } else {
            this._progress = null;
            this._progressFill = null;
        }

        let controls = new St.BoxLayout({vertical: false, style_class: "music-controls"});
        controls.set_x_align(Clutter.ActorAlign.CENTER);
        controls.set_x_expand(true);
        this._prev = this._button("media-skip-backward-symbolic", () => this._call("Previous"));
        this._play = this._button("media-playback-start-symbolic", () => this._togglePlayPause(), true);
        this._next = this._button("media-skip-forward-symbolic", () => this._call("Next"));
        controls.add_child(this._prev);
        controls.add_child(this._play);
        controls.add_child(this._next);
        body.add_child(controls);

        this._statusLabel = new St.Label({text: this._status, style_class: "music-status"});
        body.add_child(this._statusLabel);

        this._applyAccent();
        this._updateUi();
    },

    _setEllipsis: function(label) {
        try {
            label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            label.clutter_text.set_single_line_mode(true);
        } catch (e) {}
    },

    _button: function(icon, fn, primary) {
        let b = new St.Button({
            style_class: primary ? "music-button music-play" : "music-button",
            reactive: true,
            can_focus: true,
            track_hover: true
        });
        let iconActor = new St.Icon({
            icon_name: icon,
            icon_type: St.IconType.SYMBOLIC,
            icon_size: primary ? 26 : 20
        });
        b._musicIcon = iconActor;
        b.set_child(iconActor);
        b.connect("clicked", fn);
        return b;
    },

    _applyAccent: function() {
        if (this._progressFill) this._progressFill.set_style("background-color:" + this.accent + ";");
    },

    _subscribeBus: function() {
        this._nameOwnerSignal = Gio.DBus.session.signal_subscribe(
            "org.freedesktop.DBus", "org.freedesktop.DBus", "NameOwnerChanged",
            "/org/freedesktop/DBus", null, Gio.DBusSignalFlags.NONE,
            () => this._refreshPlayers()
        );
    },

    _listMpris: function() {
        let v = Gio.DBus.session.call_sync(
            "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
            "ListNames", null, new GLib.VariantType("(as)"), Gio.DBusCallFlags.NONE, 1500, null
        );
        if (!v) return [];
        return v.deep_unpack()[0].filter(n => n.indexOf("org.mpris.MediaPlayer2.") === 0);
    },

    _refreshPlayers: function() {
        if (this._destroyed) return;
        let names = [];
        try { names = this._listMpris(); } catch (e) { return; }

        let chosen = null;
        if (this.preferredPlayer && names.indexOf(this.preferredPlayer) >= 0) {
            chosen = this.preferredPlayer;
        } else if (this.playerMode !== "auto") {
            chosen = names.find(n => n.toLowerCase().indexOf(this.playerMode.toLowerCase()) >= 0) || null;
        }

        if (!chosen) {
            for (let n of names) {
                try {
                    let p = Gio.DBusProxy.new_for_bus_sync(
                        Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null, n,
                        "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", null
                    );
                    let s = p.get_cached_property("PlaybackStatus");
                    if (s && unpack(s) === "Playing") { chosen = n; break; }
                } catch (e) {}
            }
            if (!chosen && names.length) chosen = names[0];
        }

        if (chosen !== this._busName) this._setPlayer(chosen);
        else if (chosen) this._readProperties();
        else this._setPlayer(null);
    },

    _setPlayer: function(name) {
        this._stopPositionTimer();
        if (this._propsProxy && this._propsSignal) {
            try { this._propsProxy.disconnect(this._propsSignal); } catch (e) {}
        }
        this._propsSignal = 0;
        this._busName = name;
        this._playerProxy = null;
        this._propsProxy = null;

        if (!name) {
            this._metadata = {};
            this._position = 0;
            this._status = "No MPRIS player detected";
            this._updateUi();
            return;
        }

        try {
            this._playerProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null, name,
                "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", null
            );
            this._propsProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null, name,
                "/org/mpris/MediaPlayer2", "org.freedesktop.DBus.Properties", null
            );
            this._propsSignal = this._propsProxy.connect("g-properties-changed", () => this._readProperties());
            this._status = name.replace("org.mpris.MediaPlayer2.", "");
            this._readProperties();
        } catch (e) {
            this._status = "MPRIS connection error";
            this._updateUi();
        }
    },

    _readProperties: function() {
        if (!this._propsProxy) return;
        try {
            this._propsProxy.call(
                "GetAll",
                new GLib.Variant("(s)", ["org.mpris.MediaPlayer2.Player"]),
                Gio.DBusCallFlags.NONE, 1500, null,
                (proxy, res) => {
                    if (this._destroyed) return;
                    try {
                        let reply = proxy.call_finish(res);
                        let all = unpack(reply)[0] || {};
                        this._metadata = unpack(all["Metadata"]) || {};
                        this._status = firstString(all["PlaybackStatus"]) || this._status;
                        this._position = numberValue(all["Position"]);
                        this._updateUi();
                        this._updatePositionTimer();
                    } catch (e) {}
                }
            );
        } catch (e) {}
    },

    _togglePlayPause: function() {
        if (!this._playerProxy || this._toggleBusy) return;

        let oldStatus = this._status;
        let nextStatus = oldStatus === "Playing" ? "Paused" : "Playing";
        this._toggleBusy = true;

        // Change the existing icon actor immediately. Replacing the child actor here
        // can wait for a later Cinnamon frame, which made the button look unresponsive.
        this._status = nextStatus;
        this._setPlayVisual(nextStatus === "Playing");
        this._queueVisualRefresh();

        try {
            this._playerProxy.call(
                "PlayPause", null, Gio.DBusCallFlags.NONE, 1500, null,
                (proxy, res) => {
                    if (this._destroyed) return;
                    try {
                        proxy.call_finish(res);
                        // Read the real state after the player acknowledges the command.
                        this._readProperties();
                    } catch (e) {
                        this._status = oldStatus;
                        this._setPlayVisual(oldStatus === "Playing");
                        this._queueVisualRefresh();
                    }
                    this._toggleBusy = false;
                }
            );
        } catch (e) {
            this._status = oldStatus;
            this._setPlayVisual(oldStatus === "Playing");
            this._queueVisualRefresh();
            this._toggleBusy = false;
        }
    },

    _setPlayVisual: function(playing) {
        if (!this._play) return;
        if (this._play._musicIcon) {
            this._play._musicIcon.set_icon_name(playing ? "media-playback-pause-symbolic" : "media-playback-start-symbolic");
        }
        this._play.set_style_class_name("music-button music-play" + (playing ? " playing" : ""));
        if (this._statusLabel) this._statusLabel.set_text(playing ? "Playing" : "Paused");
    },

    _queueVisualRefresh: function() {
        if (this._destroyed) return;
        try {
            if (this._play) this._play.queue_redraw();
            if (this._root) this._root.queue_redraw();
            if (this._play && this._play._musicIcon) this._play._musicIcon.queue_redraw();
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (this._destroyed) return GLib.SOURCE_REMOVE;
                try {
                    if (this._play) this._play.queue_redraw();
                    if (this._root) this._root.queue_redraw();
                } catch (e) {}
                return GLib.SOURCE_REMOVE;
            });
        } catch (e) {}
    },

    _call: function(method) {
        if (!this._playerProxy) return;
        try {
            this._playerProxy.call(method, null, Gio.DBusCallFlags.NONE, 1500, null,
                (proxy, res) => {
                    if (this._destroyed) return;
                    try { proxy.call_finish(res); } catch (e) {}
                    this._readProperties();
                }
            );
        } catch (e) {}
    },

    _updateUi: function() {
        if (!this._title) return;
        let md = this._metadata || {};
        let title = firstString(md["xesam:title"]) || "No music playing";
        let artist = firstString(md["xesam:artist"]);
        let album = firstString(md["xesam:album"]);

        this._title.set_text(title);
        this._artist.set_text(artist);
        if (this._album) this._album.set_text(album);
        this._statusLabel.set_text(this._status);

        let playing = this._status === "Playing";
        this._setPlayVisual(playing);

        if (this._progress && this._progressFill) {
            let length = numberValue(md["mpris:length"]);
            let pos = numberValue(this._position);
            let ratio = length > 0 ? clamp(pos / length, 0, 1) : 0;
            let w = Math.max(1, Math.floor(Math.max(1, this._progress.get_width()) * ratio));
            this._progressFill.set_width(w);
            this._elapsed.set_text(fmtTime(pos));
            this._remaining.set_text(fmtTime(Math.max(0, length - pos)));
        }

        let art = firstString(md["mpris:artUrl"]);
        if (art && art.indexOf("file://") === 0 && this._art) {
            try {
                let path = GLib.filename_from_uri(art)[0];
                this._art.set_gicon(new Gio.FileIcon({file: Gio.File.new_for_path(path)}));
                let s = this._art.get_icon_size ? this._art.get_icon_size() : 0;
                let targetBase = this.size === "mini" ? 62 : (this.size === "large" ? 112 : 92);
                let target = Math.round(targetBase * clamp(numberValue(this.scale) / 100, 0.60, 2.00));
                this._art.set_icon_size(target);
                this._art.set_size(target, target);
            } catch (e) {
                this._art.set_icon_name("audio-x-generic");
            }
        } else if (this._art) {
            this._art.set_icon_name("audio-x-generic");
        }
    },

    _updatePositionTimer: function() {
        this._stopPositionTimer();
        if (this._status !== "Playing" || !this._progress) return;
        this._positionTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
            if (this._destroyed) return GLib.SOURCE_REMOVE;
            this._position += 1000000;
            this._updateUi();
            return this._status === "Playing" ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        });
    },

    _stopPositionTimer: function() {
        if (this._positionTimer) {
            GLib.source_remove(this._positionTimer);
            this._positionTimer = 0;
        }
    },

    _rebuild: function() {
        let current = this._busName;
        this._buildUi();
        if (current) {
            this._busName = null;
            this._setPlayer(current);
        }
    },

    on_desklet_removed: function() {
        this._destroyed = true;
        this._stopPositionTimer();
        if (this._propsProxy && this._propsSignal) {
            try { this._propsProxy.disconnect(this._propsSignal); } catch (e) {}
        }
        if (this._nameOwnerSignal) Gio.DBus.session.signal_unsubscribe(this._nameOwnerSignal);
        this._propsSignal = 0;
        this._nameOwnerSignal = 0;
        this._playerProxy = null;
        this._propsProxy = null;
        this.settings.finalize();
    }
};

function main(metadata, instanceId) {
    return new CinnamonMusicPillDesklet(metadata, instanceId);
}
