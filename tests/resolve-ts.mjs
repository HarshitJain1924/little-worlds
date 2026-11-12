import { registerHooks } from 'node:module';

// The app is bundled by Vite, so its relative imports omit extensions. Node's
// ESM loader requires them, so tests resolve the same specifiers to .ts files.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.[a-zA-Z]+$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Fall through to the original specifier for non-TypeScript targets.
      }
    }
    return nextResolve(specifier, context);
  },
});
