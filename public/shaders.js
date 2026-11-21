/* GLSL sources (plain script so the app also works from file://) */
const VERT = `#version 300 es
void main(){
  vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2);
  gl_Position = vec4(p*2.0-1.0, 0.0, 1.0);
}`;

/* One path-traced-ish sample per pixel: jittered AA + thin-lens DOF + raymarched fractal.
   Samples are averaged on the GPU through blending (see main.js). */
const FRAG_TRACE = `#version 300 es
precision highp float;
precision highp int;
out vec4 outColor;

uniform vec2  u_res;
uniform int   u_frame;
uniform int   u_formula, u_iter, u_steps, u_preview;
uniform vec4  u_p;
uniform vec3  u_ro, u_right, u_up, u_fwd;
uniform float u_f, u_pix, u_aperture, u_focus, u_dist;
uniform float u_ao, u_aoRad, u_fog, u_light, u_shadow;
uniform vec3  u_lightDir;
uniform vec3  u_colA, u_colB, u_colC, u_bgTop, u_bgBot;

uint rs;
uint pcg(uint v){ uint s=v*747796405u+2891336453u; uint w=((s>>((s>>28u)+4u))^s)*277803737u; return (w>>22u)^w; }
float rnd(){ rs=pcg(rs); return float(rs)*(1.0/4294967295.0); }

vec4 trap;

float map(vec3 p){
  vec4 orb = vec4(1e4);
  float sc = 1.0;
  if(u_formula==0){
    // Apollonian-style sphere inversion in a periodic lattice
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      p = -1.0 + 2.0*fract(0.5*p+0.5);
      float r2 = dot(p,p);
      orb = min(orb, vec4(abs(p), r2));
      float k = u_p.x/r2;
      p *= k; sc *= k;
    }
    trap = orb;
    return 0.25*abs(p.y)/sc;
  } else {
    // Kleinian-style: box fold + sphere inversion, distance to a cylinder in folded space
    vec3 cs = vec3(u_p.y, u_p.z, u_p.y);
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      p = 2.0*clamp(p,-cs,cs) - p;
      float r2 = dot(p,p);
      orb = min(orb, vec4(abs(p), r2));
      float k = max(u_p.x/r2, 1.0);
      p *= k; sc *= k;
    }
    trap = orb;
    float rxy = length(p.xy);
    return 0.7*max(rxy-u_p.w, abs(rxy*p.z)/length(p))/sc;
  }
}

vec3 calcNormal(vec3 p, float e){
  const vec2 k = vec2(1,-1);
  return normalize(k.xyy*map(p+k.xyy*e) + k.yyx*map(p+k.yyx*e) +
                   k.yxy*map(p+k.yxy*e) + k.xxx*map(p+k.xxx*e));
}

float trace(vec3 ro, vec3 rd, out float steps){
  float t = 0.0;
  float tmax = u_dist*12.0 + 20.0;
  steps = 0.0;
  for(int i=0;i<2048;i++){
    if(i>=u_steps) break;
    float d = map(ro+rd*t);
    if(d < t*u_pix*0.5 + 1e-7) return t;
    t += d*0.95;
    steps += 1.0;
    if(t>tmax) break;
  }
  return -1.0;
}

float softShadow(vec3 ro, vec3 rd, float t0){
  float res = 1.0, t = t0;
  float tmax = u_dist*2.0;
  for(int i=0;i<64;i++){
    float h = map(ro+rd*t);
    res = min(res, 6.0*h/t);
    t += max(h, t*u_pix);
    if(res<0.002 || t>tmax) break;
  }
  return clamp(res,0.0,1.0);
}

float calcAO(vec3 p, vec3 n){
  float occ = 0.0, w = 1.0;
  for(int i=1;i<=6;i++){
    float h = u_aoRad*float(i)/6.0;
    occ += (h - map(p+n*h))*w/u_aoRad;
    w *= 0.75;
  }
  return clamp(1.0 - u_ao*occ*0.9, 0.0, 1.0);
}

vec3 background(vec3 rd){
  float g = smoothstep(-0.6, 0.8, rd.y);
  return mix(u_bgBot, u_bgTop, g);
}

void main(){
  rs = pcg(uint(gl_FragCoord.x) + pcg(uint(gl_FragCoord.y) + pcg(uint(u_frame)*9781u + 1u)));

  vec2 jit = vec2(rnd(), rnd()) - 0.5;
  vec2 uv = (gl_FragCoord.xy + jit - 0.5*u_res)/u_res.y;
  vec3 ro = u_ro;
  vec3 rd = normalize(uv.x*u_right + uv.y*u_up + u_f*u_fwd);

  // thin lens
  if(u_aperture > 0.0 && u_preview==0){
    vec3 pf = ro + rd*(u_focus/dot(rd,u_fwd));
    float r = u_aperture*sqrt(rnd()), a = 6.2831853*rnd();
    ro += (u_right*cos(a) + u_up*sin(a))*r;
    rd = normalize(pf-ro);
  }

  float steps;
  float t = trace(ro, rd, steps);
  vec3 bg = background(rd);
  vec3 col = bg;

  if(t > 0.0){
    vec3 p = ro + rd*t;
    float e = max(t*u_pix, 1e-7);
    vec3 n = calcNormal(p, e);
    map(p);                       // refresh orbit trap at the hit point
    vec4 o = trap;

    // albedo from orbit trap: body / gold rims / blue accents
    vec3 alb = mix(u_colA, u_colB, smoothstep(0.0, 0.9, 1.0 - clamp(o.y*1.6,0.0,1.0)));
    alb = mix(alb, u_colC, smoothstep(0.35, 1.0, clamp(o.w*1.3,0.0,1.0))*0.55);
    alb = mix(alb, u_colB*1.2, smoothstep(0.55, 0.0, o.z)*0.35);

    vec3 L = normalize(u_lightDir);
    float dif = clamp(dot(n,L), 0.0, 1.0);
    float sha = (u_preview==0 && u_shadow>0.0) ? mix(1.0, softShadow(p+n*e*2.0, L, e*4.0), u_shadow) : 1.0;
    float ao  = calcAO(p, n);
    float stepAO = 1.0 - pow(steps/float(u_steps), 0.6)*0.6;
    ao *= stepAO;

    vec3 fillDir = normalize(vec3(-L.x, 0.35, -L.z));
    float fill = 0.5 + 0.5*dot(n, fillDir);
    float sky  = 0.5 + 0.5*n.y;
    float fre  = pow(clamp(1.0 + dot(n, rd), 0.0, 1.0), 3.0);

    vec3 lin = vec3(0.0);
    lin += u_light * dif * sha * vec3(1.0, 0.82, 0.62) * 2.2;
    lin += fill * u_colC * 0.55 * ao;
    lin += sky * mix(u_bgBot, u_bgTop, 0.5) * 0.45 * ao;
    col = alb * lin;
    col += fre * u_colB * 0.35 * ao;

    // specular glint
    vec3 h = normalize(L - rd);
    col += pow(clamp(dot(n,h),0.0,1.0), 40.0) * dif * sha * 0.35 * u_colB;

    // distance fog toward background
    float fogA = 1.0 - exp(-t*u_fog/u_dist);
    col = mix(col, bg, clamp(fogA, 0.0, 1.0));
  }
  outColor = vec4(col, 1.0);
}`;

const FRAG_DISPLAY = `#version 300 es
precision highp float;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec2  u_out;
uniform float u_exposure, u_grain, u_vignette, u_sat, u_seed;

vec3 aces(vec3 x){
  const float a=2.51, b=0.03, c=2.43, d=0.59, e=0.14;
  return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
}
float hash(vec2 p){ vec3 p3=fract(vec3(p.xyx)*0.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }

vec3 fetchB(vec2 uv){
  ivec2 sz = textureSize(u_tex,0);
  vec2 st = uv*vec2(sz) - 0.5;
  ivec2 i0 = ivec2(floor(st));
  vec2 f = fract(st);
  ivec2 mx = sz-1;
  vec3 a = texelFetch(u_tex, clamp(i0,ivec2(0),mx),0).rgb;
  vec3 b = texelFetch(u_tex, clamp(i0+ivec2(1,0),ivec2(0),mx),0).rgb;
  vec3 c = texelFetch(u_tex, clamp(i0+ivec2(0,1),ivec2(0),mx),0).rgb;
  vec3 d = texelFetch(u_tex, clamp(i0+ivec2(1,1),ivec2(0),mx),0).rgb;
  return mix(mix(a,b,f.x), mix(c,d,f.x), f.y);
}

void main(){
  vec2 uv = gl_FragCoord.xy/u_out;
  vec3 c = fetchB(uv) * u_exposure;
  c = aces(c);
  float l = dot(c, vec3(0.2126,0.7152,0.0722));
  c = mix(vec3(l), c, u_sat);
  c = pow(c, vec3(1.0/2.2));
  vec2 q = uv-0.5;
  c *= 1.0 - u_vignette*dot(q,q)*1.6;
  float g = hash(gl_FragCoord.xy + u_seed) + hash(gl_FragCoord.yx*1.37 + 7.0) - 1.0;
  c += g*u_grain*0.12;
  outColor = vec4(c, 1.0);
}`;
