# 3D Fractals

Browser-based GPU raymarcher for 3D fractals (Kleinian, Apollonian, Mandelbox, Menger sponge, Mandelbulb, Sierpinski tetrahedron), with progressive depth of field,
soft shadows, ambient occlusion, film grain and PNG export. Fly through the fractal like a spaceship.

## Controls

| Input | Action |
| --- | --- |
| Drag | Look around |
| W / A / S / D | Fly forward / left / back / right |
| Space / C | Up / down |
| Q / E | Roll |
| Arrow keys | Look |
| Shift | Boost x4 |
| Mouse wheel | Fly speed |
| X | Level the horizon |

Speed scales with the free distance ahead, so you can keep diving in without hitting the surface.

## Run with Docker

```
docker compose up -d --build
```

Then open http://localhost:8080.

The app is plain static files in `public/` (WebGL2 + `EXT_color_buffer_float`), so it also works by opening
`public/index.html` directly or with any static file server.
