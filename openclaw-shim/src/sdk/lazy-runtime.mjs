export function createLazyRuntimeNamedExport(loader, exportName) {
  return async () => {
    const mod = await loader();
    if (mod && exportName in mod) return mod[exportName];
    return mod?.default;
  };
}

export function createLazyRuntimeModule(loader) {
  return async () => loader();
}
