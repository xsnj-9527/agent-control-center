const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentControl', {
  overview: () => ipcRenderer.invoke('control:overview'),
  details: (agent, id) => ipcRenderer.invoke('control:details', agent, id),
  chooseHome: (agent) => ipcRenderer.invoke('control:choose-home', agent),
  chooseCli: (agent) => ipcRenderer.invoke('control:choose-cli', agent),
  chooseWorkspace: () => ipcRenderer.invoke('control:workspace'),
  jobs: () => ipcRenderer.invoke('control:jobs'),
  logs: (id) => ipcRenderer.invoke('control:logs', id),
  start: (input) => ipcRenderer.invoke('control:start', input),
  cancel: (id) => ipcRenderer.invoke('control:cancel', id),
  approve: (job, id, allow) => ipcRenderer.invoke('control:approve', job, id, allow),
  respond: (job, id, answers) => ipcRenderer.invoke('control:respond', job, id, answers),
  billing: (filter) => ipcRenderer.invoke('control:billing', filter),
  saveRate: (rate) => ipcRenderer.invoke('control:save-rate', rate),
  deleteRate: (rate) => ipcRenderer.invoke('control:delete-rate', rate),
  importBill: () => ipcRenderer.invoke('control:import-bill'),
  removeBill: (id) => ipcRenderer.invoke('control:remove-bill', id),
  exportBill: (filter) => ipcRenderer.invoke('control:export-bill', filter),
  onChanged(callback) { const listener = () => callback(); ipcRenderer.on('control:changed', listener); return () => ipcRenderer.removeListener('control:changed', listener); },
});
