window.UNO_CONFIG = {
  serverUrl: ['localhost', '127.0.0.1'].includes(location.hostname)
    ? 'ws://localhost:3001/ws'
    : 'wss://openboard-uno-2026.onrender.com/ws',
  supabaseUrl: '',
  supabaseAnonKey: '',
};
