export function ConfigError({ message }: { message: string }) {
  return (
    <div className="grid min-h-screen place-items-center bg-bg px-6">
      <div className="panel max-w-lg p-6">
        <h1 className="text-[18px]">The portal isn't configured yet</h1>
        <p className="mt-2 text-[14px] text-muted">{message}</p>
        <p className="mt-3 text-[13.5px] text-muted">Find both values in Supabase under Project Settings, then API. Restart the dev server after editing .env.</p>
      </div>
    </div>
  );
}
