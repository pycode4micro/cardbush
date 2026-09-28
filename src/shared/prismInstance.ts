import { Prism } from 'prism-react-renderer';

// Prism's optional grammar modules register against this instance. Initialize
// it before their side-effect imports; no DOM scanning/highlightAll is used.
(globalThis as typeof globalThis & { Prism: typeof Prism }).Prism = Prism;

export { Prism };
