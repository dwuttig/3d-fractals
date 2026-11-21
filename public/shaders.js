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
uniform int   u_iter, u_steps, u_preview;
#define u_formula FORMULA   // set per program: only the selected formula is compiled
uniform vec4  u_p;
uniform mat3  u_rot;     // twist/tilt rotation applied every iteration
uniform vec3  u_sh;      // shift / Julia offset
uniform int   u_xf;      // 1 when rotation or shift is non-zero
uniform vec3  u_ro, u_right, u_up, u_fwd;
uniform float u_f, u_pix, u_aperture, u_focus, u_dist, u_bound;
uniform float u_ao, u_aoRad, u_fog, u_light, u_shadow;
uniform vec3  u_lightDir;
uniform vec3  u_colA, u_colB, u_colC, u_bgTop, u_bgBot;

uint rs;
uint pcg(uint v){ uint s=v*747796405u+2891336453u; uint w=((s>>((s>>28u)+4u))^s)*277803737u; return (w>>22u)^w; }
float rnd(){ rs=pcg(rs); return float(rs)*(1.0/4294967295.0); }

vec4 trap;

// Cone of height 1 (base at y = 0, apex at y = 1) and base radius Rb; exact in the meridian plane.
float coneSd(vec3 q, float Rb){
  float rho = length(q.xz);
  return max(-q.y, (rho + q.y*Rb - Rb)/sqrt(1.0 + Rb*Rb));
}

// quaternion with the real part in .x
vec4 qsq(vec4 z){ return vec4(z.x*z.x - dot(z.yzw,z.yzw), 2.0*z.x*z.yzw); }
vec4 qcube(vec4 z){ float v2 = dot(z.yzw,z.yzw); return vec4(z.x*(z.x*z.x - 3.0*v2), (3.0*z.x*z.x - v2)*z.yzw); }

float map(vec3 p){
  vec4 orb = vec4(1e4);
  float sc = 1.0;
#if FORMULA==0
    // Apollonian-style sphere inversion in a periodic lattice
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      if(u_xf==1) p = u_rot*p + u_sh;
      p = -1.0 + 2.0*fract(0.5*p+0.5);
      float r2 = dot(p,p);
      orb = min(orb, vec4(abs(p), r2));
      float k = u_p.x/r2;
      p *= k; sc *= k;
    }
    trap = orb;
    return 0.25*abs(p.y)/sc;
#elif FORMULA==1
    // Kleinian-style: box fold + sphere inversion, distance to a cylinder in folded space
    vec3 cs = vec3(u_p.y, u_p.z, u_p.y);
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      if(u_xf==1) p = u_rot*p + u_sh;
      p = 2.0*clamp(p,-cs,cs) - p;
      float r2 = dot(p,p);
      orb = min(orb, vec4(abs(p), r2));
      float k = max(u_p.x/r2, 1.0);
      p *= k; sc *= k;
    }
    trap = orb;
    float rxy = length(p.xy);
    return 0.7*max(rxy-u_p.w, abs(rxy*p.z)/length(p))/sc;
#elif FORMULA==2
    // Mandelbox: box fold + sphere fold + scale/translate
    vec3 p0 = p + (u_xf==1 ? u_sh : vec3(0.0)); float dr = 1.0;
    float minR2 = u_p.y*u_p.y, fixR2 = u_p.z*u_p.z;
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      if(u_xf==1) p = u_rot*p;
      p = clamp(p,-1.0,1.0)*2.0 - p;
      float r2 = dot(p,p);
      if(r2 < minR2){ float t = fixR2/minR2; p *= t; dr *= t; }
      else if(r2 < fixR2){ float t = fixR2/r2; p *= t; dr *= t; }
      orb = min(orb, vec4(abs(p)*0.2, r2*0.1));
      p = p*u_p.x + p0; dr = dr*abs(u_p.x) + 1.0;
    }
    trap = orb;
    return length(p)/abs(dr);
#elif FORMULA==3
    // Menger sponge: a cube minus recursively smaller crosses
    vec3 q = abs(p) - 1.0;
    float d = length(max(q,0.0)) + min(max(q.x,max(q.y,q.z)),0.0);
    float s = 1.0;
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      if(u_xf==1) p = u_rot*p + u_sh;
      vec3 a = mod(p*s, 2.0) - 1.0;
      s *= 3.0;
      vec3 r = abs(1.0 - 3.0*abs(a));
      float da = max(r.x,r.y), db = max(r.y,r.z), dc = max(r.z,r.x);
      float c = (min(da,min(db,dc)) - u_p.x)/s;
      orb = min(orb, vec4(abs(a), dot(a,a)*0.3));
      d = max(d, c);
    }
    trap = orb;
    return d;
#elif FORMULA==4 || FORMULA==9 || FORMULA==19
    // Mandelbulb (9: Burning-ship variant, z -> |z| every iteration)
    vec3 z = p, pc = p + (u_xf==1 ? u_sh : vec3(0.0)); float dr = 1.0, r = 0.0, pw = u_p.x;
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      r = length(z);
      if(r > 2.0) break;
      if(u_xf==1) z = u_rot*z;
      if(u_formula==9) z = abs(z);
      if(u_formula==19) z.y = -z.y;      // conjugate: flips the azimuth
      float theta = acos(clamp(z.z/r,-1.0,1.0))*pw;
      float phi = atan(z.y,z.x)*pw;
      dr = pow(r,pw-1.0)*pw*dr + 1.0;
      float zr = pow(r,pw);
      orb = min(orb, vec4(abs(z)*0.5, r*r*0.5));
      z = zr*vec3(sin(theta)*cos(phi), sin(phi)*sin(theta), cos(theta)) + pc;
    }
    trap = orb;
    return 0.5*log(max(r,1e-6))*r/dr;
#elif FORMULA==5
    // Sierpinski tetrahedron: fold into one corner, scale by 2 about the vertex
    vec3 z = p;
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      if(u_xf==1) z = u_rot*z + u_sh;
      if(z.x+z.y < 0.0) z.xy = -z.yx;
      if(z.x+z.z < 0.0) z.xz = -z.zx;
      if(z.y+z.z < 0.0) z.zy = -z.yz;
      orb = min(orb, vec4(abs(z)*0.3, dot(z,z)*0.1));
      z = z*2.0 - vec3(1.0);
      sc *= 2.0;
    }
    trap = orb;
    return (length(z) - u_p.x)/sc;
#elif FORMULA>=6 && FORMULA<=8
    // Solid KIFS fractals: 6 octahedron, 7 Cantor dust (cubes), 8 tetrahedron. u_p = (scale, offset)
    vec3 z = p; float s0 = u_p.x, off = u_p.y;
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      if(u_xf==1) z = u_rot*z + u_sh;
      if(u_formula==8){
        if(z.x+z.y < 0.0) z.xy = -z.yx;
        if(z.x+z.z < 0.0) z.xz = -z.zx;
        if(z.y+z.z < 0.0) z.zy = -z.yz;
        orb = min(orb, vec4(abs(z)*0.3, dot(z,z)*0.1));
        z = z*s0 - vec3((s0-1.0)*off);
      } else {
        z = abs(z);
        if(u_formula==6){
          if(z.x < z.y) z.xy = z.yx;
          if(z.x < z.z) z.xz = z.zx;
          if(z.y < z.z) z.yz = z.zy;
          orb = min(orb, vec4(z*0.5, dot(z,z)*0.2));
          z = z*s0 - vec3((s0-1.0)*off, 0.0, 0.0);
        } else {
          orb = min(orb, vec4(z*0.3, dot(z,z)*0.1));
          z = z*s0 - vec3((s0-1.0)*off);
        }
      }
      sc *= s0;
    }
    trap = orb;
    float d;
    if(u_formula==6) d = (abs(z.x)+abs(z.y)+abs(z.z) - 1.0)*0.57735027;
    else if(u_formula==7){ vec3 q = abs(z) - 1.0; d = length(max(q,0.0)) + min(max(q.x,max(q.y,q.z)),0.0); }
    else d = (max(abs(z.x+z.y)-z.z, abs(z.x-z.y)+z.z) - 1.0)*0.57735027;
    return d/sc;
#elif FORMULA==10
    // Quadratic bulb: triplex square  (x,y,z) -> (x2-y2-z2, 2xz, 2xy) + c
    vec3 z = p, pc = p + (u_xf==1 ? u_sh : vec3(0.0)); float dr = 1.0, r = 0.0;
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      r = length(z);
      if(r > 2.0) break;
      if(u_xf==1) z = u_rot*z;
      orb = min(orb, vec4(abs(z)*0.5, r*r*0.5));
      dr = 2.0*r*dr + 1.0;
      z = vec3(z.x*z.x - z.y*z.y - z.z*z.z, 2.0*z.x*z.z, 2.0*z.x*z.y) + pc;
    }
    trap = orb;
    return 0.5*log(max(r,1e-6))*r/dr;
#elif FORMULA==11
    // Quaternion Julia set z -> z^2 + c, cut at w = 0.  u_p = c
    vec3 q3 = (u_xf==1) ? (u_rot*p + u_sh) : p;
    vec4 z = vec4(q3, 0.0);
    float md2 = 1.0, mz2 = dot(z,z);
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      md2 *= 4.0*mz2;
      z = vec4(z.x*z.x - dot(z.yzw,z.yzw), 2.0*z.x*z.yzw) + u_p;
      mz2 = dot(z,z);
      orb = min(orb, vec4(abs(z.xyz)*0.5, mz2*0.1));
      if(mz2 > 4.0) break;
    }
    trap = orb;
    return 0.25*sqrt(mz2/md2)*log(mz2);
#elif FORMULA==16 || FORMULA==25
    // Quaternion Julia z -> z^3 + c (16) or z^4 + c (25), cut at w = 0.  u_p = c
    vec3 q3 = (u_xf==1) ? (u_rot*p + u_sh) : p;
    vec4 z = vec4(q3, 0.0);
    float dr = 1.0, r = 0.0, pw = (u_formula==16) ? 3.0 : 4.0;
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      r = length(z);
      if(r > 2.0) break;
      dr = pw*pow(r, pw-1.0)*dr;
      z = ((u_formula==16) ? qcube(z) : qsq(qsq(z))) + u_p;
      orb = min(orb, vec4(abs(z.xyz)*0.5, dot(z,z)*0.1));
    }
    trap = orb; r = length(z);
    return 0.5*log(max(r,1e-6))*r/max(dr,1e-30);
#elif FORMULA==17
    // Quaternion Mandelbrot z -> z^n + c with c = (x, y, z, w0), n = 2 or 3.  u_p = (w0, n)
    vec3 q3 = (u_xf==1) ? (u_rot*p + u_sh) : p;
    vec4 c = vec4(q3, u_p.x), z = vec4(0.0);
    float dr = 1.0, r = 0.0, pw = (u_p.y > 2.5) ? 3.0 : 2.0;
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      r = length(z);
      if(r > 2.0) break;
      dr = pw*pow(r, pw-1.0)*dr + 1.0;
      z = ((pw > 2.5) ? qcube(z) : qsq(z)) + c;
      orb = min(orb, vec4(abs(z.xyz)*0.5, dot(z,z)*0.1));
    }
    trap = orb; r = length(z);
    return 0.5*log(max(r,1e-6))*r/dr;
#elif FORMULA==18
    // Box-fold bulb: box fold, then the quadratic triplex square.  u_p = (box limit, scale)
    vec3 z = p, pc = p + (u_xf==1 ? u_sh : vec3(0.0));
    float dr = 1.0, r = 0.0, L = u_p.x, k = u_p.y;
    for(int i=0;i<20;i++){
      if(i>=u_iter) break;
      if(u_xf==1) z = u_rot*z;
      z = clamp(z,-L,L)*2.0 - z;
      r = length(z);
      if(r > 4.0) break;
      orb = min(orb, vec4(abs(z)*0.3, r*r*0.1));
      dr = 2.0*k*r*dr + 1.0;
      z = k*vec3(z.x*z.x - z.y*z.y - z.z*z.z, 2.0*z.x*z.z, 2.0*z.x*z.y) + pc;
    }
    trap = orb; r = length(z);
    return 0.5*log(max(r,1e-6))*r/dr;
#elif FORMULA==20
    // Sphere flake: a unit sphere with six children of radius k on the axes, recursively. Fold into one octant
    // with abs + sort, scale about the child centre, and keep the union (min) of every level.  u_p.x = k
    vec3 z = (u_xf==1) ? (u_rot*p + u_sh) : p;
    float k = u_p.x, f = 1.0/k;
    float d = length(z) - 1.0;
    for(int i=0;i<12;i++){
      if(i>=u_iter) break;
      z = abs(z);
      if(z.x < z.y) z.xy = z.yx;
      if(z.x < z.z) z.xz = z.zx;
      if(z.y < z.z) z.yz = z.zy;
      orb = min(orb, vec4(z*0.3, dot(z,z)*0.1));
      z = z*f - vec3((1.0+k)*f, 0.0, 0.0);
      sc *= f;
      d = min(d, (length(z) - 1.0)/sc);
    }
    trap = orb;
    return d;
#elif FORMULA>=21 && FORMULA<=24
    // Cube carver: every cell of the cube is split in thirds; the cells whose number m of coordinates in the
    // middle third is NOT in the kept set (bit m of Pattern) are removed, recursively.  u_p = (pattern, width)
    vec3 q = (u_xf==1) ? (u_rot*p + u_sh) : p;
    vec3 b = abs(q) - 1.0;
    float d = length(max(b,0.0)) + min(max(b.x,max(b.y,b.z)),0.0);
    int pat = int(u_p.x + 0.5);
    float w = u_p.y, s3 = 1.0;
    for(int i=0;i<10;i++){
      if(i>=u_iter) break;
      vec3 a = mod(q*s3 + 1.0, 2.0) - 1.0;
      vec3 t = vec3(w) - abs(a);                         // > 0 where the coordinate is in the middle third
      float hi = max(t.x,max(t.y,t.z)), lo = min(t.x,min(t.y,t.z)), mid = t.x + t.y + t.z - hi - lo;
      float c = -1e9;
      if(((pat    ) & 1) == 0) c = max(c, -hi);          // m = 0: all outer (corners)
      if(((pat>>1) & 1) == 0) c = max(c, min(hi, -mid)); // m = 1: edges
      if(((pat>>2) & 1) == 0) c = max(c, min(mid, -lo)); // m = 2: face centres
      if(((pat>>3) & 1) == 0) c = max(c, lo);            // m = 3: the centre
      d = max(d, c/s3);
      orb = min(orb, vec4(abs(a)*0.5, dot(a,a)*0.2));
      s3 *= 3.0;
    }
    trap = orb;
    return d;
#elif FORMULA==26
    // Romanesco: a cone whose surface carries rings of florets -- smaller copies of the whole -- placed on a
    // golden-angle spiral. Row k sits at distance u_k = 0.97 * rho^k from the apex (log spacing keeps the florets
    // similar in size to their neighbours); each row has M florets, rotated by alpha relative to the row before.
    // At every level all florets of the four nearest rows (two sectors each) are added to the shape; we then step
    // into the nearest one and repeat. Florets are sunk slightly into the surface so their bases stay hidden.
    // u_p = (cone radius, floret fill, columns M, spiral angle)
    vec3 pp = (u_xf==1) ? (u_rot*p + u_sh) : p;
    vec3 q = pp*0.5 + vec3(0.0, 0.5, 0.0);           // cone: base y = 0, apex y = 1 (2 world units tall)
    float Rb = u_p.x, fill = u_p.y, M = max(u_p.z, 3.0), alpha = u_p.w;
    float delta = 6.2831853/M;
    float rho = clamp(1.0 - 1.5707963*fill/M, 0.5, 0.97), lnr = log(rho);
    float scl = 1.0, nl = float(max(u_iter,1)), tag = 0.0;
    float d = coneSd(q, Rb);
    for(int lvl=0; lvl<7; lvl++){
      if(lvl >= u_iter) break;
      float u = max(1.0 - q.y, 1e-4);
      float theta = atan(q.z, q.x);
      float k0 = floor(log(u/0.97)/lnr);
      float best = 1e9, bs = 1.0; vec3 bq = q;
      for(int a=0;a<4;a++){
        float k = max(k0 - 1.0 + float(a), 0.0);
        float uk = 0.97*pow(rho, k), yk = 1.0 - uk, rk = Rb*uk, fk = 3.1415927*uk*fill/M;
        float phi = k*alpha, m0 = floor((theta - phi)/delta);
        for(int b=0;b<2;b++){
          float th = phi + (m0 + float(b))*delta;
          float ct = cos(th), st = sin(th);
          vec3 nrm = normalize(vec3(ct, Rb + 0.9, st));      // floret axis: surface normal tilted up towards the apex
          vec3 w = vec3(-st, 0.0, ct);
          vec3 dd = q - (vec3(rk*ct, yk, rk*st) - nrm*(0.45*fk));
          vec3 ql = vec3(dot(dd,w), dot(dd,nrm), dot(dd, cross(w,nrm)))/fk;
          float dc = coneSd(ql, Rb)*fk;
          if(dc/scl < d){ d = dc/scl; tag = float(lvl + 1)/nl; }
          if(dc < best){ best = dc; bq = ql; bs = fk; }
        }
      }
      q = bq; scl /= bs;
    }
    trap = vec4(vec3(tag*0.5), (1.0 - tag)*0.4);
    return 2.0*0.7*d;                                        // x2: world scale, x0.7: safety margin
#else
    // Layered triply-periodic minimal surfaces (12 gyroid, 13 Schwarz P, 14 Schwarz D, 15 Neovius).
    // Each octave adds a thinner shell at a higher frequency; the union of the shells is the foam.
    vec3 q = (u_xf==1) ? (u_rot*p + u_sh) : p;
    float th = u_p.x, fq = u_p.y, os = u_p.z;
    float K = (u_formula==12) ? 2.0 : (u_formula==13) ? 1.8 : (u_formula==14) ? 3.0 : 9.0;   // gradient bounds
    float d = 1e9, ti = th;       // finer octaves get thinner shells too, so the foam stays open
    for(int i=0;i<8;i++){
      if(i>=u_iter) break;
      vec3 w = q*fq;
      vec3 s1 = sin(w), c1 = cos(w);
      float g;
      if(u_formula==12) g = dot(s1, c1.yzx);
      else if(u_formula==13) g = c1.x + c1.y + c1.z;
      else if(u_formula==14) g = s1.x*s1.y*s1.z + s1.x*c1.y*c1.z + c1.x*s1.y*c1.z + c1.x*c1.y*s1.z;
      else g = 3.0*(c1.x + c1.y + c1.z) + 4.0*c1.x*c1.y*c1.z;
      d = min(d, (abs(g) - ti)/(K*fq));
      orb = min(orb, vec4(abs(s1)*0.5, abs(g)*0.3));
      fq *= os; ti /= os;
    }
    trap = orb;
    return max(d, length(p) - u_p.w);        // clip to a ball of radius u_p.w
#endif
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
  if(u_bound > 0.0){                       // bounded fractal: rays that miss the sphere cost nothing
    float b = dot(ro,rd), h = b*b - (dot(ro,ro) - u_bound*u_bound);
    if(h < 0.0) return -1.0;
    h = sqrt(h);
    if(-b + h < 0.0) return -1.0;
    t = max(-b - h, 0.0);
    tmax = min(tmax, -b + h);
  }
  float d = 1e9;
  for(int i=0;i<2048;i++){
    if(i>=u_steps) break;
    d = map(ro+rd*t);
    if(d < t*u_pix*0.5 + 1e-7) return t;
    t += d*0.95;
    steps += 1.0;
    if(t>tmax) break;
  }
  // Out of steps but still skimming a surface (grazing rays, or the reduced step budget of the preview):
  // treat it as a hit instead of letting it fall through to the sky colour.
  if(t <= tmax && d < t*u_pix*24.0 + 1e-6) return t;
  return -1.0;
}

float softShadow(vec3 ro, vec3 rd, float t0){
  float res = 1.0, t = t0;
  float tmax = u_dist*2.0;
  for(int i=0;i<40;i++){
    float h = map(ro+rd*t);
    res = min(res, 6.0*h/t);
    t += max(h, t*u_pix);
    if(res<0.002 || t>tmax) break;
  }
  return clamp(res,0.0,1.0);
}

float calcAO(vec3 p, vec3 n){
  // Two random taps per sample (one from the near half, one from the far half of the six original taps).
  // 3x each makes this an unbiased estimate of the six-tap sum; the progressive accumulation averages it out.
  float occ = 0.0;
  if(u_preview==1 || u_frame<6){
    for(int i=1;i<=6;i++){
      float h = u_aoRad*float(i)/6.0;
      occ += (h - map(p+n*h))*pow(0.75, float(i-1))/u_aoRad;
    }
  } else {
    for(int k=0;k<2;k++){
      int i = 1 + k*3 + int(rnd()*3.0);
      float h = u_aoRad*float(i)/6.0;
      occ += 3.0*(h - map(p+n*h))*pow(0.75, float(i-1))/u_aoRad;
    }
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
    vec3 alb;
    if(u_formula < 2){
      alb = mix(u_colA, u_colB, smoothstep(0.0, 0.9, 1.0 - clamp(o.y*1.6,0.0,1.0)));
      alb = mix(alb, u_colC, smoothstep(0.35, 1.0, clamp(o.w*1.3,0.0,1.0))*0.55);
      alb = mix(alb, u_colB*1.2, smoothstep(0.55, 0.0, o.z)*0.35);
    } else {
      float k1 = smoothstep(0.0, 1.0, o.w*2.5);
      float k2 = smoothstep(0.1, 0.8, (o.x + o.y + o.z)*0.8);
      alb = mix(u_colA, u_colB, k1);
      alb = mix(alb, u_colC, k2*0.65);
    }

    vec3 L = normalize(u_lightDir);
    float dif = clamp(dot(n,L), 0.0, 1.0);
    float sha = (u_shadow>0.0 && dif>0.0) ? mix(1.0, softShadow(p+n*e*2.0, L, e*4.0), u_shadow) : 1.0;
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
