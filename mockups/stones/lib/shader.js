/*
 * Direction B: stones drawn live by a fragment shader, lit from the pointer.
 * One WebGL canvas draws every stone in it (browsers cap live GL contexts at
 * roughly 16, so one canvas per stone does not scale to a wall).
 * Depends on stones.js. Exposes Stones.GL.
 */
(function (root) {
  "use strict";
  const S = root.Stones;
  const VERT = "attribute vec2 a;varying vec2 v;void main(){v=a;gl_Position=vec4(a,0.,1.);}";
  const FRAG = `
precision highp float;
varying vec2 v;
uniform vec2 uA[8]; uniform vec2 uN[8]; uniform int uCount;
uniform vec3 uPal[5]; uniform vec3 uAccent; uniform vec3 uLight;
uniform float uInset, uSteps, uSeed, uPx; uniform int uLook, uFinish; uniform bool uSmooth; uniform vec2 uC;
vec3 ramp(float t){t=clamp(t,0.,1.)*4.;vec3 c=mix(uPal[0],uPal[1],clamp(t,0.,1.));c=mix(c,uPal[2],clamp(t-1.,0.,1.));c=mix(c,uPal[3],clamp(t-2.,0.,1.));return mix(c,uPal[4],clamp(t-3.,0.,1.));}
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7))+uSeed)*43758.5453);}
vec4 stone(vec2 p){
  vec3 L=normalize(uLight); vec3 N; float d=1e3; float tableness=0.;
  if(uSmooth){
    float a=-.2; mat2 r=mat2(cos(a),-sin(a),sin(a),cos(a)); vec2 q=r*p/vec2(.86,.62); float rr=length(q);
    d=(1.-rr)*.62; N=normalize(vec3(r*(q/vec2(.86,.62))*-1.*-1.,sqrt(max(1.-rr*rr,.03))*1.25));
  } else {
    vec2 n=vec2(0.);
    for(int i=0;i<8;i++){ if(i>=uCount) break; float di=dot(uN[i],uA[i]-p); if(di<d){d=di;n=uN[i];} }
    float k=d/uInset;
    if(k>=1.){N=vec3(0.,0.,1.);tableness=1.;}
    else{ float step=floor(k*uSteps); float tilt=1.15-.32*step; N=normalize(vec3(n*tilt,1.)); }
  }
  float alpha=smoothstep(0.,uPx*1.5,d);
  if(alpha<=0.) return vec4(0.);
  vec2 pc=p-uC; float ang=atan(pc.y,pc.x);
  // the underside: a star of facets seen through the top, which flashes as the light moves
  float M=float(uCount)*2.; if(uSmooth) M=1.;
  float sec=floor(ang/6.28318*M+.5); float sa=sec*6.28318/M; vec2 n2=vec2(cos(sa),sin(sa));
  float fl=dot(N.xy,L.xy)*.9+N.z*L.z*.35;
  float crown=.42+.5*fl;
  vec3 col;
  float gloss=uFinish==0?.0:1.;
  if(uLook==0){ // clear
    vec3 t;
    for(int c=0;c<3;c++){ float o=(float(c)-1.)*(uFinish>=2?.11:.0); vec2 nn=vec2(cos(sa+o),sin(sa+o));
      float f=dot(normalize(nn*.8+N.xy*.6),-L.xy)+hash(vec2(sec,3.))*.5-.25; t[c]=smoothstep(-.25,.35,f); }
    float inner=mix(.5,1.,tableness);
    vec3 base=vec3(ramp(mix(crown,t.r,inner*.7)).r,ramp(mix(crown,t.g,inner*.7)).g,ramp(mix(crown,t.b,inner*.7)).b);
    col=base+uPal[4]*.22*pow(max(0.,1.-length(pc+L.xy*.25)*1.6),2.);
  } else if(uLook==1){ // milky: a glow that drifts under the surface with the light
    float g=exp(-dot(pc-L.xy*.32,pc-L.xy*.32)*5.5);
    col=ramp(.5+.22*fl)+uAccent*g*.55;
  } else if(uLook==2){ // banded
    vec2 w=pc+vec2(.35,.2)+.06*vec2(sin(pc.y*9.+uSeed),cos(pc.x*7.+uSeed)); float b=sin(length(w*vec2(1.,1.6))*22.);
    col=ramp(.38+.3*fl+.16*smoothstep(-.3,.3,b));
  } else if(uLook==3){ // metal: a hard horizon in each facet
    vec3 R=reflect(vec3(0.,0.,-1.),N); float e=smoothstep(-.12,.12,dot(R.xy,L.xy)+.1+hash(vec2(sec,d>uInset?9.:1.))*.2-.1);
    col=ramp(mix(.16,.92,e)*(.7+.3*N.z)+.1*tableness);
  } else { // volcanic glass
    float sh=exp(-pow(dot(pc,normalize(L.xy+vec2(.001)))*3.-.4,2.)*6.);
    col=ramp(.1+.34*max(fl,0.))+mix(uAccent,vec3(.18,.84,.75),.5+.5*sin(ang*2.))*sh*.42*gloss;
  }
  // facet lines
  if(!uSmooth){ float k=d/uInset; float e=abs(fract(k*uSteps+.5)-.5)/uSteps*uInset; if(k<1.02) col+=uPal[4]*.22*(1.-smoothstep(0.,uPx*1.6,e))*step(.02,k); }
  if(uFinish==0){ col=mix(col,uPal[3],.2)*.96+.03*hash(floor(p*90.)); }
  vec3 H=normalize(L+vec3(0.,0.,1.));
  float sp=pow(max(dot(N,H),0.),uSmooth?60.:28.)*(uSmooth?.9:.55)*gloss;
  col+=vec3(sp);
  col+=uPal[4]*pow(1.-smoothstep(0.,.06,d),2.)*.3*gloss; // rim
  if(uFinish>=3){ // the star follows the light, as it does in a real star stone
    vec2 sc=pc-L.xy*.16; float st=0.;
    for(int i=0;i<3;i++){ float a=.3+float(i)*1.0472; vec2 dr=vec2(cos(a),sin(a)); st+=exp(-abs(sc.x*dr.y-sc.y*dr.x)*46.)*exp(-length(sc)*1.6); }
    col+=vec3(st)*.6;
  }
  return vec4(col*alpha,alpha);
}
void main(){
  vec4 c=vec4(0.);
  c+=stone(v+vec2(.25,.75)*uPx*.5); c+=stone(v+vec2(-.75,.25)*uPx*.5); c+=stone(v+vec2(-.25,-.75)*uPx*.5); c+=stone(v+vec2(.75,-.25)*uPx*.5);
  gl_FragColor=c*.25;
}`;

  const LOOKS = { clear: 0, milky: 1, banded: 2, metal: 3, glass: 4 };
  const INSET = { prism: [0.34, 2], terrace: [0.34, 3], delta: [0.24, 1], point: [0.2, 1], baton: [0.15, 1], pebble: [1, 1] };

  function geometry(cut) {
    if (cut === "pebble") return { A: [], N: [], count: 0, c: [0, 0] };
    const g = S.buildCut(cut, S.rng(1));
    const P = g.outline.map((p) => [(p[0] - 100) / 104, -(p[1] - 100) / 104]);
    let cx = 0, cy = 0; P.forEach((p) => { cx += p[0]; cy += p[1]; }); cx /= P.length; cy /= P.length;
    const A = [], N = [];
    for (let i = 0; i < P.length; i++) {
      const a = P[i], b = P[(i + 1) % P.length];
      let nx = b[1] - a[1], ny = -(b[0] - a[0]); const l = Math.hypot(nx, ny); nx /= l; ny /= l;
      if (nx * ((a[0] + b[0]) / 2 - cx) + ny * ((a[1] + b[1]) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
      A.push(a[0], a[1]); N.push(nx, ny);
    }
    return { A, N, count: P.length, c: [cx, cy] };
  }
  const rgb = (hex) => S.hexToRgb(hex).map((v) => Math.pow(v / 255, 1));

  /**
   * mount(canvas, items): items are { spec, x, y, size } in CSS pixels
   * inside the canvas. Returns { draw(lightFor), stats } or null without WebGL.
   */
  function mount(canvas, items) {
    const gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n) => gl.getUniformLocation(prog, n);
    const u = { A: U("uA"), N: U("uN"), count: U("uCount"), pal: U("uPal"), accent: U("uAccent"), light: U("uLight"), inset: U("uInset"), steps: U("uSteps"), seed: U("uSeed"), px: U("uPx"), look: U("uLook"), fin: U("uFinish"), smooth: U("uSmooth"), c: U("uC") };
    const geo = {};
    let dpr = 1;
    function resize() {
      dpr = Math.min(2, root.devicePixelRatio || 1);
      const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    }
    function draw(lightFor) {
      resize();
      gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.SCISSOR_TEST);
      for (const it of items) {
        const s = it.spec, m = S.MAT[s.material], g = geo[s.cut] || (geo[s.cut] = geometry(s.cut));
        const px = it.size * dpr, x = Math.round(it.x * dpr), y = Math.round(canvas.height - (it.y + it.size) * dpr);
        gl.viewport(x, y, px, px); gl.scissor(x, y, px, px);
        const a8 = new Float32Array(16), n8 = new Float32Array(16); a8.set(g.A); n8.set(g.N);
        gl.uniform2fv(u.A, a8); gl.uniform2fv(u.N, n8); gl.uniform1i(u.count, g.count);
        const hue = (S.rng((s.seed >>> 0) || 1)() - 0.5) * 14;
        gl.uniform3fv(u.pal, new Float32Array(m.pal.flatMap((h) => rgb(S.rotateHue(h, hue)))));
        gl.uniform3fv(u.accent, new Float32Array(rgb(m.accent)));
        const l = lightFor ? lightFor(it) : [-0.5, 0.75, 0.9];
        gl.uniform3f(u.light, l[0], l[1], l[2]);
        gl.uniform1f(u.inset, INSET[s.cut][0]); gl.uniform1f(u.steps, INSET[s.cut][1]);
        gl.uniform1f(u.seed, (s.seed % 1000) / 37); gl.uniform1f(u.px, 2 / px);
        gl.uniform1i(u.look, LOOKS[m.look]); gl.uniform1i(u.fin, S.FIN[s.finish || "cut"].index);
        gl.uniform1i(u.smooth, s.cut === "pebble" ? 1 : 0); gl.uniform2f(u.c, g.c[0], g.c[1]);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.SCISSOR_TEST);
    }
    /** Force the GPU to finish so a timing means something. */
    function timed(lightFor) {
      const t = performance.now(); draw(lightFor);
      const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return performance.now() - t;
    }
    return { draw, timed, gl, shaderBytes: FRAG.length + VERT.length };
  }

  S.GL = { mount };
})(typeof window !== "undefined" ? window : globalThis);
