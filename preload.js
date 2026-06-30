'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gstApp', {
  getLocalApiPort:    ()     => ipcRenderer.invoke('get-local-api-port'),
  reportCaptcha:      (args) => ipcRenderer.invoke('report-captcha', args),
  logError:           (args) => ipcRenderer.invoke('log-error', args),
  listAccounts:       ()     => ipcRenderer.invoke('list-accounts'),
  saveAccount:        (args) => ipcRenderer.invoke('save-account', args),
  deleteAccount:      (args) => ipcRenderer.invoke('delete-account', args),
  getAccountPassword: (args) => ipcRenderer.invoke('get-account-password', args),
  exportAllAccounts:  ()     => ipcRenderer.invoke('export-all-accounts'),
  healthCheck:       (args) => ipcRenderer.invoke('api-health', args),
  loadConfig:        ()     => ipcRenderer.invoke('load-config'),
  saveConfig:        (cfg)  => ipcRenderer.invoke('save-config', cfg),
  pickFile:          ()     => ipcRenderer.invoke('pick-file'),
  readInputFile:      (p)    => ipcRenderer.invoke('read-input-file', p),
  readCredentialFile: (p)    => ipcRenderer.invoke('read-credential-file', p),
  login:             (args) => ipcRenderer.invoke('api-login', args),
  submitCaptcha:     (args) => ipcRenderer.invoke('api-captcha', args),
  checkFilingStatus: (args) => ipcRenderer.invoke('api-filing-status', args),
  logout:            (args) => ipcRenderer.invoke('api-logout', args),
  saveExcel:         (args) => ipcRenderer.invoke('save-excel', args),
  sendEmail:         (args) => ipcRenderer.invoke('send-email', args),
  openFile:          (p)    => ipcRenderer.invoke('open-file', p),
  downloadPdf:       (args) => ipcRenderer.invoke('api-download-pdf', args),
  savePdf:           (args) => ipcRenderer.invoke('save-pdf', args),
  saveZip:           (args) => ipcRenderer.invoke('save-zip', args),
});
