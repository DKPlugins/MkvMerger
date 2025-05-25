const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');

function createWindow() {
	const win = new BrowserWindow({
		width: 1000,
		height: 800,
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			nodeIntegration: false,
			contextIsolation: true,
			enableRemoteModule: false,
			sandbox: false
		}
	});
	
	const indexPath = path.join(__dirname, '../index.html');
	win.loadFile(indexPath);
	
	// Открываем DevTools только в режиме разработки
	if (process.env.NODE_ENV === 'development') {
		win.webContents.openDevTools();
	}
	
	// Обработка ошибок загрузки
	win.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
		console.error('Failed to load:', errorCode, errorDescription);
	});
}

app.whenReady().then(() => {
	createWindow();
	
	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		}
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') {
		app.quit();
	}
});

// Обработка ошибок приложения
process.on('uncaughtException', (error) => {
	console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
	console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

ipcMain.handle('select-root-folder', async () => {
	try {
		const result = await dialog.showOpenDialog({
			properties: ['openDirectory'],
			title: 'Выберите корневую папку'
		});
		if (result.canceled) return null;
		return result.filePaths[0];
	} catch (error) {
		console.error('Error selecting folder:', error);
		return null;
	}
});

ipcMain.handle('select-mkvmerge-file', async () => {
	try {
		const result = await dialog.showOpenDialog({
			properties: ['openFile'],
			title: 'Выберите исполняемый файл mkvmerge',
			filters: [
				{ name: 'Executable Files', extensions: ['exe'] },
				{ name: 'All Files', extensions: ['*'] }
			],
			defaultPath: 'C:\\Program Files\\MKVToolNix'
		});
		if (result.canceled) return null;
		return result.filePaths[0];
	} catch (error) {
		console.error('Error selecting mkvmerge file:', error);
		return null;
	}
});

// Обработчики событий прогресса
ipcMain.on('merge-progress', (event, data) => {
	// Пересылаем событие прогресса в renderer процесс
	event.sender.send('merge-progress', data);
});

ipcMain.on('merge-complete', (event, data) => {
	// Пересылаем событие завершения в renderer процесс
	event.sender.send('merge-complete', data);
});