// Security/UI perspectives: adjacent dangerous attributes, encoded/nested input,
// benign links, and empty attribution. Exercise the installed distribution's
// public control API; only the map host is stubbed (no sanitizer copy/mock).
import {expect, it} from 'vitest';
import {AttributionControl, type Map as MapLibreMap} from 'maplibre-gl';

function renderAttribution(html: string) {
  const control = new AttributionControl({compact: false, customAttribution: html});
  const host = {
    style: {tileManagers: {}},
    _getUIString: () => 'Attribution',
    getCanvasContainer: () => document.createElement('div'),
    on: () => {}, off: () => {},
  } as unknown as MapLibreMap;
  const container = control.onAdd(host);
  const content = container.querySelector('.maplibregl-ctrl-attrib-inner')!;
  control.onRemove();
  return content;
}

it.each([
  '<details open onload="1" ontoggle="alert(1)">x</details>',
  '<a href="javascript:alert(1)" onclick="alert(1)">x</a>',
  '<div><a href="java&#x73;cript:alert(1)" onmouseover="alert(1)" onclick="alert(1)">x</a></div>',
])('removes unsafe attributes through the shipped attribution control: %s', html => {
  const content = renderAttribution(html);
  for (const node of content.querySelectorAll('*')) {
    for (const attribute of Array.from(node.attributes)) {
      expect(attribute.name).not.toMatch(/^on/i);
      if (['href', 'src', 'xlink:href'].includes(attribute.name)) {
        expect(attribute.value.replace(/\s/g, '')).not.toMatch(/^(javascript|data):/i);
      }
    }
  }
});

it('preserves ordinary attribution text and HTTPS links', () => {
  const content = renderAttribution('&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors');
  expect(content.textContent).toBe('© OpenStreetMap contributors');
  expect(content.querySelector('a')?.getAttribute('href')).toBe('https://www.openstreetmap.org/copyright');
});

it('accepts an empty attribution without creating content', () => {
  expect(renderAttribution('').childNodes).toHaveLength(0);
});
