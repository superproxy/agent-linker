import('@openclaw/feishu/dist/.setup/monitor.account-D5j6WomE.mjs')
  .then(() => console.log('plugin-ok'))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
