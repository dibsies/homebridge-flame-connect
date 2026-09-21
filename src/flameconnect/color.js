const clamp = (v, max) => Math.max(0, Math.min(max, Number(v) || 0));

export function hsvToRgbw({ hue, saturation, brightness }) {
  const h = clamp(hue, 360) % 360 / 60;
  const s = clamp(saturation, 100) / 100;
  const v = clamp(brightness, 100) / 100;
  const c = v * s, x = c * (1 - Math.abs(h % 2 - 1)), m = v - c;
  const [r, g, b] = [[c,x,0],[x,c,0],[0,c,x],[0,x,c],[x,0,c],[c,0,x]][Math.floor(h)];
  return { red: Math.round(r*255), green: Math.round(g*255), blue: Math.round(b*255), white: Math.round(m*255) };
}

export function rgbwToHsv(color = {}) {
  const w = clamp(color.white,255);
  const [r,g,b] = ['red','green','blue'].map(k=>Math.min(255,clamp(color[k],255)+w)/255);
  const max=Math.max(r,g,b), min=Math.min(r,g,b), d=max-min;
  let h=0;
  if (d) h= max===r ? ((g-b)/d)%6 : max===g ? (b-r)/d+2 : (r-g)/d+4;
  return { hue:(h*60+360)%360, saturation:max ? d/max*100 : 0, brightness:max*100 };
}
