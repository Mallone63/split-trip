export default function SetupHelp() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-bold text-slate-900">Trip Split</h1>
      <p className="text-sm text-slate-600">
        The app is not connected to a backend yet. It needs a free Supabase project to store
        shared expenses.
      </p>
      <ol className="list-decimal space-y-3 rounded-2xl bg-white p-4 pl-8 text-sm text-slate-700 shadow-sm">
        <li>
          Create a project at <span className="font-mono">supabase.com</span> (the free tier is
          more than enough).
        </li>
        <li>
          Open the SQL Editor and run <span className="font-mono">supabase/schema.sql</span> from
          this project.
        </li>
        <li>
          Copy the project URL and anon key into a{' '}
          <span className="font-mono">.env</span> file:
          <pre className="mt-1 overflow-x-auto rounded bg-slate-100 p-2 text-xs">
            {'VITE_SUPABASE_URL=https://YOUR-PROJECT.supabase.co\nVITE_SUPABASE_ANON_KEY=YOUR-ANON-KEY'}
          </pre>
        </li>
        <li>Restart the dev server (or redeploy) and reload this page.</li>
      </ol>
    </div>
  );
}
