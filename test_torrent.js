(async () => {
  console.log('Testing WebTorrent client initialization via dynamic import...');
  try {
    const { default: WebTorrent } = await import('webtorrent');
    const client = new WebTorrent();
    console.log('WebTorrent client created successfully!');
    console.log('Available client methods:', Object.keys(client).filter(k => typeof client[k] === 'function').slice(0, 10));
    client.destroy(() => {
      console.log('WebTorrent client destroyed successfully. Test PASSED!');
      process.exit(0);
    });
  } catch (e) {
    console.error('Test FAILED:', e.message);
    process.exit(1);
  }
})();
