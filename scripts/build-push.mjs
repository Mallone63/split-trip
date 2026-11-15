import { build } from 'esbuild';
await build({
  entryPoints: ['supabase/functions/push/index.ts'],
  outfile: 'supabase/functions/push/bundle.js',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  plugins: [
    {
      name: 'deno-npm',
      setup(b) {
        b.onResolve(
          { filter: /^(@supabase\/supabase-js|web-push)$/ },
          (args) => ({
            path:
              args.path === 'web-push'
                ? 'npm:web-push@3.6.7'
                : 'npm:@supabase/supabase-js@2.118.0',
            external: true,
          }),
        );
      },
    },
  ],
});
