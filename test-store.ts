import Store from 'electron-store';
const store = new Store({ projectName: 'client', name: 'followfree-data', encryptionKey: 'followfree-local-encryption-key' });
const accounts = store.get('accounts') || [];
console.log('Total accounts:', accounts.length);
accounts.forEach(a => console.log(a.id, a.platform, a.status, 'isManual:', a.isManual));
