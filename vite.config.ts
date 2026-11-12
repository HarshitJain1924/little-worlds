import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true },
  preview: { host: true },
  build: {
    // The island scene and the playable prototype are separate entry points.
    rollupOptions: {
      input: {
        main: 'index.html',
        play: 'play.html',
      },
    },
  },
});
