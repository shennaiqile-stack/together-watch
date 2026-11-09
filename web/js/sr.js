/* 一起看 · AI 超分（本地 GPU 实时增强）
   方案参考 Kazumi：使用 Anime4K v4 的 GLSL 着色器（Clamp → Restore CNN → Upscale CNN x2）。
   着色器由 tools/make_shaders.py 预转换成 WebGL2 多趟管线，内嵌在 anime4k.js。
     fast    = Restore CNN S + Upscale x2 S（效率优先）
     quality = Restore CNN M + Upscale x2 M（质量优先）
   每台电脑用自己的显卡算，不占房主算力，也不增加上传带宽。
   原始着色器来自 bloc97/Anime4K（MIT License）。 */
(function () {
  const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, aPos.y * 0.5 + 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

  const BLIT = `#version 300 es
precision highp float;
uniform sampler2D uTex;
in vec2 vUv;
out vec4 fragColor;
void main() { fragColor = vec4(texture(uTex, vUv).rgb, 1.0); }`;

  /* 显卡不支持浮点渲染目标时的兜底：双三次 + 锐化 */
  const SIMPLE = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 fragColor;
vec4 crWeights(float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return vec4(-0.5 * t3 + t2 - 0.5 * t,
               1.5 * t3 - 2.5 * t2 + 1.0,
              -1.5 * t3 + 2.0 * t2 + 0.5 * t,
               0.5 * t3 - 0.5 * t2);
}
vec3 bicubic(vec2 uv) {
  vec2 p = uv * (1.0 / uTexel) - 0.5;
  vec2 base = floor(p);
  vec2 f = p - base;
  vec4 wx = crWeights(f.x);
  vec4 wy = crWeights(f.y);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      vec2 tap = (base + vec2(float(x - 1), float(y - 1)) + 0.5) * uTexel;
      float w = wx[x] * wy[y];
      sum += texture(uTex, tap).rgb * w;
      wsum += w;
    }
  }
  return sum / wsum;
}
void main() {
  vec3 c = bicubic(vUv);
  vec3 blur = (
    texture(uTex, vUv + vec2(uTexel.x, 0.0)).rgb +
    texture(uTex, vUv - vec2(uTexel.x, 0.0)).rgb +
    texture(uTex, vUv + vec2(0.0, uTexel.y)).rgb +
    texture(uTex, vUv - vec2(0.0, uTexel.y)).rgb
  ) * 0.25;
  fragColor = vec4(clamp(c + (c - blur) * 0.55, 0.0, 1.0), 1.0);
}`;

  class SuperRes {
    constructor(video, canvas) {
      this.video = video;
      this.canvas = canvas;
      this.mode = null;
      this.running = false;
      this.gl = null;
      this.pipes = {};
      this.targets = new Map();
      this._frames = 0;
      this._raf = false;
      this._slowSince = 0;
      this._drawMs = 0;
      this._fbIncomplete = '';
      this._onFrame = this._onFrame.bind(this);
      this._init();
    }

    static create(video, canvas) {
      if (!video || !canvas) return null;
      try {
        const sr = new SuperRes(video, canvas);
        return sr.ok ? sr : null;
      } catch (e) {
        console.warn('超分初始化失败', e);
        return null;
      }
    }

    get ok() { return !!this.gl; }

    _shader(type, src) {
      const gl = this.gl;
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(log || '着色器编译失败');
      }
      return sh;
    }

    _program(fragSrc) {
      const gl = this.gl;
      const prog = gl.createProgram();
      gl.attachShader(prog, this.vert);
      gl.attachShader(prog, this._shader(gl.FRAGMENT_SHADER, fragSrc));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(prog);
        gl.deleteProgram(prog);
        throw new Error(log || '着色器链接失败');
      }
      return prog;
    }

    _init() {
      const gl = this.canvas.getContext('webgl2', {
        alpha: false, antialias: false, depth: false, stencil: false,
        preserveDrawingBuffer: false, powerPreference: 'high-performance',
      });
      if (!gl) return;
      this.gl = gl;
      this.floatOK = !!gl.getExtension('EXT_color_buffer_float');
      this.vert = this._shader(gl.VERTEX_SHADER, VERT);

      this.blitProg = this._program(BLIT);
      this.simpleProg = this._program(SIMPLE);
      this.uBlit = gl.getUniformLocation(this.blitProg, 'uTex');
      this.uSimple = gl.getUniformLocation(this.simpleProg, 'uTex');
      this.uSimpleTexel = gl.getUniformLocation(this.simpleProg, 'uTexel');

      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER,
        new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      const loc = gl.getAttribLocation(this.blitProg, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);

      this.videoTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

      const v = this.video;
      v.addEventListener('seeked', () => { if (this.mode) this._draw(); });
      v.addEventListener('loadeddata', () => { if (this.mode) this.resize(); });
    }

    get pipeline() {
      const lib = window.ANIME4K;
      const mode = this.mode;
      if (!lib || !this.floatOK) return null;
      if (mode !== 'fast' && mode !== 'quality') return null;
      if (!this.pipes[mode]) {
        try {
          this.pipes[mode] = lib[mode].map((p) => {
            const prog = this._program(p.frag);
            const uniforms = {};
            p.binds.forEach((name) => {
              uniforms[name] = {
                tex: gl0(this.gl, prog, 'uT_' + name),
                size: gl0(this.gl, prog, 'uS_' + name),
              };
            });
            return { p, prog, uniforms };
          });
        } catch (e) {
          console.warn('Anime4K 着色器编译失败：' + e.message);
          this.pipes[mode] = null;
          return null;
        }
      }
      return this.pipes[mode];
    }

    setMode(mode) {
      if (!this.ok) return false;
      if (!mode || mode === 'off') {
        this.mode = null;
        this.running = false;
        this.canvas.hidden = true;
        return true;
      }
      const prev = this.mode;
      if (mode === 'fast' || mode === 'quality') {
        this.mode = mode;
        if (!this.pipeline) {
          this.mode = null;
          if (!this.floatOK) {
            // 没有浮点纹理支持，退化为简单超分
            this.mode = 'simple';
          } else {
            return false;
          }
        }
      } else if (mode === 'simple') {
        this.mode = 'simple';
      } else {
        return false;
      }
      this.canvas.hidden = false;
      if (prev && prev !== this.mode) this._purgeTargets();
      this._slowSince = 0;
      this.resize();
      this._report('enable');
      if (!this.running) {
        this.running = true;
        this._frames = 0;
        this._schedule();
        setTimeout(() => {
          if (this.running && this._frames === 0) {
            this._raf = true;          // rVFC 没回调（部分窗口/隐藏视频会这样）
            this._report('rvc-stall');
            this._schedule();
          }
        }, 900);
      }
      return true;
    }

    resize() {
      if (!this.ok) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = this.canvas.getBoundingClientRect();
      const w = Math.max(1, Math.min(2560, Math.round((rect.width || 640) * dpr)));
      const h = Math.max(1, Math.round((rect.height || 360) * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      if (this.mode) this._draw();
    }

    _schedule() {
      if (!this.running) return;
      const v = this.video;
      if (!this._raf && v.requestVideoFrameCallback) {
        v.requestVideoFrameCallback(this._onFrame);
      } else {
        requestAnimationFrame(this._onFrame);
      }
    }

    _onFrame() {
      if (!this.running) return;
      this._draw();
      this._schedule();
    }

    /* 渲染目标按「名字 + 尺寸」缓存。尺寸变化时必须新建而不是覆盖旧纹理：
       最后一趟升采样会用 MAIN 作为输入再写回 MAIN，直接删旧纹理会把输入一起弄没，
       表现就是有声音没画面。 */
    _target(key, w, h) {
      const gl = this.gl;
      const k = key + ':' + w + 'x' + h;
      let t = this.targets.get(k);
      if (t) return t;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, this.floatOK ? gl.RGBA16F : gl.RGBA,
        w, h, 0, gl.RGBA, this.floatOK ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D, tex, 0);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      if (status !== gl.FRAMEBUFFER_COMPLETE && !this._fbIncomplete) {
        this._fbIncomplete = k + ':' + status;
        this._report('fbo-incomplete');
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      t = { tex, fbo, w, h };
      this.targets.set(k, t);
      return t;
    }

    /* 诊断：把关键状态回传到主程序，写进 data/sr-report.jsonl，方便排查黑屏 */
    _report(reason) {
      try {
        const gl = this.gl;
        const v = this.video;
        fetch('/api/sr-report', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            reason,
            mode: this.mode,
            floatOK: !!this.floatOK,
            vw: v.videoWidth, vh: v.videoHeight,
            cw: this.canvas.width, ch: this.canvas.height,
            frames: this._frames,
            drawMs: Math.round(this._drawMs),
            raf: this._raf,
            fbIncomplete: this._fbIncomplete,
            glErr: gl ? gl.getError() : -1,
            passes: this.pipes[this.mode] ? this.pipes[this.mode].length : 0,
            ua: navigator.userAgent.slice(0, 150),
          }),
        }).catch(() => {});
      } catch (e) {}
    }

    _purgeTargets() {
      const gl = this.gl;
      this.targets.forEach((t) => {
        gl.deleteTexture(t.tex);
        gl.deleteFramebuffer(t.fbo);
      });
      this.targets.clear();
    }

    /* 尺寸表达式在生成阶段已转成 JS（如 (sz['MAIN'][0] * 2)） */
    _size(expr, sz, axis) {
      if (!expr) return sz.MAIN ? sz.MAIN[axis] : 1;
      const v = Function('sz', 'return (' + expr + ')')(sz);
      if (!v || !isFinite(v)) return sz.MAIN ? sz.MAIN[axis] : 1;
      return Math.max(1, Math.round(v));
    }

    _draw() {
      const gl = this.gl;
      const v = this.video;
      if (!v.videoWidth || !v.videoHeight || v.readyState < 2) return;
      const t0 = performance.now();
      if (this._vw !== v.videoWidth || this._vh !== v.videoHeight) {
        this._vw = v.videoWidth;
        this._vh = v.videoHeight;
        this._purgeTargets();       // 换分辨率时重建缓存的纹理
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, v);
      gl.bindVertexArray(this.vao);

      let main = { tex: this.videoTex, w: v.videoWidth, h: v.videoHeight };

      if (this.mode === 'simple') {
        const t = this._target('simple', this.canvas.width, this.canvas.height);
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.viewport(0, 0, t.w, t.h);
        gl.useProgram(this.simpleProg);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
        gl.uniform1i(this.uSimple, 0);
        gl.uniform2f(this.uSimpleTexel, 1 / v.videoWidth, 1 / v.videoHeight);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        main = { tex: t.tex, w: t.w, h: t.h };
      } else {
        const pipe = this.pipeline;
        if (!pipe) return;
        const saved = {};
        const sz = { MAIN: [main.w, main.h] };
        let idx = 0;
        for (const item of pipe) {
          const p = item.p;
          const w = this._size(p.w, sz, 0);
          const h = this._size(p.h, sz, 1);
          /* 每趟单独一块渲染目标：如果按 SAVE 名字复用，前一趟刚采样过的纹理
             可能又被当成这一趟的输出，构成采样-附件回环（GL_INVALID_OPERATION） */
          const out = this._target('pass' + idx, w, h);
          idx++;
          gl.bindFramebuffer(gl.FRAMEBUFFER, out.fbo);
          gl.viewport(0, 0, w, h);
          gl.useProgram(item.prog);
          p.binds.forEach((name, i) => {
            const src = (name === 'MAIN' || name === 'HOOKED') ? main : saved[name];
            if (!src) return;
            gl.activeTexture(gl.TEXTURE0 + i);
            gl.bindTexture(gl.TEXTURE_2D, src.tex);
            const u = item.uniforms[name];
            gl.uniform1i(u.tex, i);
            gl.uniform2f(u.size, src.w, src.h);
          });
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          const savedTex = { tex: out.tex, w, h };
          saved[p.save] = savedTex;
          sz[p.save] = [w, h];
          if (p.save === 'MAIN') main = savedTex;
        }
      }

      // 贴合显示区域（保持比例、居中），黑边由 clear 填充
      const cw = this.canvas.width;
      const ch = this.canvas.height;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, cw, ch);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      const scale = Math.min(cw / main.w, ch / main.h);
      const dw = Math.max(1, Math.round(main.w * scale));
      const dh = Math.max(1, Math.round(main.h * scale));
      gl.viewport(Math.round((cw - dw) / 2), Math.round((ch - dh) / 2), dw, dh);
      gl.useProgram(this.blitProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, main.tex);
      gl.uniform1i(this.uBlit, 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.bindVertexArray(null);
      this._drawMs = performance.now() - t0;
      this._frames++;
      if (this._frames === 1 || this._frames === 30) this._report('draw');

      /* 显卡跟不上就自动降档：质量 >34ms 先退效率档，效率仍 >50ms 就关掉 */
      const lim = this.mode === 'quality' ? 34 : 50;
      if (this._drawMs > lim) {
        if (!this._slowSince) this._slowSince = t0;
        if (t0 - this._slowSince > 2000) {
          this._slowSince = 0;
          const next = this.mode === 'quality' ? 'fast' : 'off';
          this.setMode(next);
          if (this.onDegrade) { try { this.onDegrade(next); } catch (e) {} }
        }
      } else {
        this._slowSince = 0;
      }
    }
  }

  function gl0(gl, prog, name) { return gl.getUniformLocation(prog, name); }

  window.SuperRes = SuperRes;
})();
