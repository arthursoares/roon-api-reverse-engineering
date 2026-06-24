// @ts-check
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// Project Pages site: https://<user>.github.io/<repo>/
// Override SITE / BASE via env if you fork (e.g. a custom domain).
const site = process.env.SITE_URL || 'https://arthursoares.github.io';
const base = process.env.SITE_BASE || '/roon-api-reverse-engineering';

const repo = 'https://github.com/arthursoares/roon-api-reverse-engineering';

// Starlight bases its own nav/asset URLs, but root-relative links authored in
// markdown/MDX content and in the hero frontmatter are emitted raw (e.g.
// `href="/journey/"`), which 404s under a project-Pages base path. Prepend the
// base to those at the end of the build so source stays clean and forkable.
function baseLinksIntegration() {
  return {
    name: 'base-relative-links',
    hooks: {
      'astro:build:done': ({ dir }) => {
        if (!base || base === '/') return;
        const prefix = base.replace(/\/$/, '');
        // href="/x" but NOT href="/<base>..." and NOT href="//..."
        const re = new RegExp(`href="/(?!${prefix.slice(1)}/)(?!/)`, 'g');
        const root = fileURLToPath(dir);
        const walk = (d) => {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.html')) {
              const html = readFileSync(p, 'utf8');
              const fixed = html.replace(re, `href="${prefix}/`);
              if (fixed !== html) writeFileSync(p, fixed);
            }
          }
        };
        walk(root);
      },
    },
  };
}

export default defineConfig({
  site,
  base,
  integrations: [
    baseLinksIntegration(),
    starlight({
      title: 'roon-internal-api',
      tagline: 'a reverse-engineering experiment',
      description:
        'Notes from poking at the private binary protocol Roon’s desktop app uses to talk to a Core. A proof-of-concept, not a product.',
      customCss: ['./src/styles/custom.css'],
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/site/` },
      lastUpdated: true,
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Overview', link: '/' },
            { label: 'The journey', link: '/journey/' },
          ],
        },
        {
          label: 'Protocol reference',
          autogenerate: { directory: 'protocol' },
        },
        {
          label: 'Using the client',
          autogenerate: { directory: 'api' },
        },
        {
          label: 'Contributing',
          items: [{ label: 'Contributing guide', link: '/contributing/' }],
        },
      ],
    }),
  ],
});
