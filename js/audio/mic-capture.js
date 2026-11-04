(function (global) {
  "use strict";

  const TAHtml = global.TAHtml;
  const ENABLED_KEY = "ta.mic.enabled";
  const WORKLET = `
    class MicProcessor extends AudioWorkletProcessor {
      constructor() {
        super();
        this.frame = new ArrayBuffer(1920);
        this.view = new DataView(this.frame);
        this.offset = 0;
        this.index = 0;
        this.next = 0;
        this.previous = 0;
        this.pending = false;
        this.port.onmessage = () => { this.pending = false; };
      }

      process(inputs) {
        const channels = inputs[0];
        if (!channels || !channels.length) return true;
        for (let i = 0; i < channels[0].length; i += 1) {
          let sample = 0;
          for (let c = 0; c < channels.length; c += 1) sample += channels[c][i];
          sample /= channels.length;
          if (this.index === 0) this.previous = sample;
          while (this.next <= this.index) {
            const value = Math.max(-1, Math.min(1,
              this.previous + (sample - this.previous) * (this.next - this.index + 1)));
            this.view.setInt16(this.offset * 2, value < 0 ? value * 32768 : value * 32767, true);
            this.offset += 1;
            if (this.offset === 960) {
              if (!this.pending) {
                this.port.postMessage({ buf: this.frame, time: currentTime }, [this.frame]);
                this.pending = true;
                this.frame = new ArrayBuffer(1920);
                this.view = new DataView(this.frame);
              }
              this.offset = 0;
            }
            this.next += sampleRate / 48000;
          }
          this.previous = sample;
          this.index += 1;
        }
        return true;
      }
    }
    registerProcessor("ta-mic", MicProcessor);
  `;

  class MicCapture {
    constructor() {
      this.enabled = true;
      try {
        this.enabled = global.localStorage.getItem(ENABLED_KEY) !== "false";
      } catch (_error) {
        // no-op
      }
      this.allowed = true;
      this.state = "off";
      this._session = null;
      this._logged = false;
      global.addEventListener("pagehide", () => this.stop());
    }

    setEnabled(enabled) {
      this.enabled = enabled;
      try {
        global.localStorage.setItem(ENABLED_KEY, String(enabled));
      } catch (_error) {
        // no-op
      }
      if (!enabled) this.stop();
    }

    setAllowed(allowed) {
      this.allowed = allowed;
      if (!allowed) this.stop();
    }

    async start() {
      if (!this.enabled || !this.allowed || this._session) return;
      const session = {};
      this._session = session;
      this._setState("waiting permission");
      let moduleUrl;
      try {
        const Context = global.AudioContext || global.webkitAudioContext;
        if (!global.navigator.mediaDevices?.getUserMedia || !Context || !global.AudioWorkletNode) {
          throw new Error("Microphone capture is unsupported (a secure context is required)");
        }
        const context = new Context();
        session.context = context;
        if (!context.audioWorklet) throw new Error("AudioWorklet is unsupported");
        const resumed = context.resume().catch(() => {});
        // Request permission in the gesture, before awaiting worklet setup.
        const stream = await global.navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
        });
        session.stream = stream;
        if (this._session !== session) return;
        await resumed;
        moduleUrl = global.URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
        await context.audioWorklet.addModule(moduleUrl);
        if (this._session !== session) return;
        const node = new global.AudioWorkletNode(context, "ta-mic");
        session.node = node;
        session.source = context.createMediaStreamSource(stream);
        node.port.onmessage = (event) => {
          if (this._session !== session) return;
          const age = Math.max(0, context.currentTime - event.data.time);
          const socket = session.socket;
          if (age < 0.18 && socket && socket.readyState === 1 && socket.bufferedAmount <= 19200) {
            try { socket.send(event.data.buf); } catch {}
          }
          node.port.postMessage("ack");
        };
        stream.getTracks().forEach((track) => {
          track.addEventListener("ended", () => {
            if (this._session === session) this.stop();
          });
        });
        session.source.connect(node);
        // The processor leaves its output silent; never monitor the microphone.
        node.connect(context.destination);
        this._connect(session);
        this._setState("active");
      } catch (error) {
        if (this._session === session) {
          this.stop();
          this._setState("denied");
          if (!this._logged) {
            console.warn("[Mic] Capture unavailable:", error);
            this._logged = true;
          }
        }
      } finally {
        if (moduleUrl) global.URL.revokeObjectURL(moduleUrl);
        if (this._session !== session) this._release(session);
      }
    }

    stop() {
      const session = this._session;
      this._session = null;
      if (session) {
        this._sendState("stop", session);
        this._release(session);
      }
      this._setState("off");
    }

    _release(session) {
      global.clearTimeout(session.reconnectTimer);
      if (session.socket) {
        session.socket.onopen = session.socket.onclose = session.socket.onerror = null;
        try { session.socket.close(); } catch {}
        session.socket = null;
      }
      if (session.node) {
        session.node.port.onmessage = null;
        session.node.port.close();
        session.node.disconnect();
      }
      if (session.source) session.source.disconnect();
      if (session.stream) session.stream.getTracks().forEach((track) => track.stop());
      if (session.context && session.context.state !== "closed") {
        session.context.close().catch(() => {});
      }
    }

    _connect(session) {
      if (this._session !== session) return;
      const reconnect = () => {
        if (this._session === session) {
          session.reconnectTimer = global.setTimeout(() => this._connect(session), 1000);
        }
      };
      try {
        const protocol = global.location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new global.WebSocket(protocol + "//" + global.location.host + "/sockets/mic");
        session.socket = socket;
        socket.onopen = () => {
          if (this._session === session && session.socket === socket) this._sendState("start");
        };
        socket.onerror = () => {};
        socket.onclose = () => {
          if (session.socket !== socket) return;
          session.socket = null;
          reconnect();
        };
      } catch (_error) {
        reconnect();
      }
    }

    _sendState(state, session = this._session) {
      const socket = session && session.socket;
      if (socket && socket.readyState === 1) {
        try { socket.send(JSON.stringify({ type: "mic", state })); } catch {}
      }
    }

    _setState(state) {
      this.state = state;
      global.dispatchEvent(new CustomEvent("mic-state", { detail: state }));
    }
  }

  TAHtml.MicCapture = MicCapture;
})(window);
