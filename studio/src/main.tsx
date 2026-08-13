/**
 * The browser entry — the one place a config becomes a cast.
 *
 * Studio bundles no participants, so this is where the user's own description of their fabric
 * gets in: a `<script type="application/json" id="studio-config">` block the page carries. This
 * area's `index.html` has none, so `npm run dev` opens on the empty stage; a host that wants a
 * cast inlines its own config file into that block (or serves its own page around this bundle)
 * and gets exactly the fabric it described. Nothing here goes looking for one.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import { embeddedConfigText, readStudioConfig } from './config.ts';

const root = document.getElementById('root');
if (!root) throw new Error('studio: #root missing from index.html');

const { backbone, problems } = readStudioConfig(embeddedConfigText(document));

createRoot(root).render(
  <StrictMode>
    <App backbone={backbone} problems={problems} />
  </StrictMode>,
);
