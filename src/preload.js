const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Константы
const MAX_CONCURRENT_PROCESSES = 2;

// Глобальные переменные для управления процессами
let activeProcesses = new Map(); // videoIndex -> process
let isCancelled = false;

contextBridge.exposeInMainWorld('api', {
	selectRoot: () => ipcRenderer.invoke('select-root-folder'),
	selectMkvMergeFile: () => ipcRenderer.invoke('select-mkvmerge-file'),
	checkFileExists: (filePath) => {
		try {
			return fs.existsSync(filePath);
		} catch (error) {
			console.error(`Error checking file existence for ${filePath}:`, error);
			return false;
		}
	},
	onMergeProgress: (callback) => {
		ipcRenderer.on('merge-progress', (event, data) => callback(data));
	},
	onMergeComplete: (callback) => {
		ipcRenderer.on('merge-complete', (event, data) => callback(data));
	},
	cancelMerge: () => {
		try {
			isCancelled = true;
			console.log(`Cancelling ${activeProcesses.size} active processes...`);
			
			// Завершаем все активные процессы
			activeProcesses.forEach((process, videoIndex) => {
				try {
					if (process && !process.killed) {
						process.kill('SIGTERM');
						console.log(`Killed process for video ${videoIndex + 1}`);
						
						// Отправляем событие отмены
						ipcRenderer.send('merge-complete', { 
							videoIndex, 
							success: false, 
							error: 'Отменено пользователем' 
						});
					}
				} catch (err) {
					console.error(`Error killing process for video ${videoIndex + 1}:`, err.message);
				}
			});
			
			// Очищаем список процессов
			activeProcesses.clear();
			
			console.log('All processes cancelled');
			return true;
		} catch (err) {
			console.error('Error cancelling processes:', err.message);
			return false;
		}
	},
  scanFolders: (root) => {
    try {
      function scanAudioDirs(dir) {
        let folders = [];
        try {
			if (!fs.existsSync(dir)) {
				console.warn(`Directory does not exist: ${dir}`);
				return folders;
			}
          
			const entries = fs.readdirSync(dir, { withFileTypes: true });
			const exts = ['.ac3', '.dts', '.flac', '.mka', '.wav', '.aac'];
			const audioFiles = entries.filter(e => e.isFile() && exts.includes(path.extname(e.name).toLowerCase()));

			if (audioFiles.length > 0) {
				folders.push({
				path: dir,
				fileCount: audioFiles.length
				});
			}
          
          // recurse
          for (let e of entries) {
            if (e.isDirectory()) {
              try {
                folders = folders.concat(scanAudioDirs(path.join(dir, e.name)));
              } catch (err) {
                console.warn(`Error scanning directory ${path.join(dir, e.name)}:`, err.message);
              }
            }
          }
        } catch (err) {
          console.error(`Error reading directory ${dir}:`, err.message);
        }
        return folders;
      }

      const videos = [];
      function scanVideos(dir) {
        try {
          if (!fs.existsSync(dir)) {
            console.warn(`Directory does not exist: ${dir}`);
            return;
          }
          
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (let e of entries) {
            const full = path.join(dir, e.name);
            try {
              // Ищем только файлы в корневой папке, без рекурсии
              if (e.isFile() && path.extname(e.name).toLowerCase() === '.mkv') {
                videos.push(full);
              }
            } catch (err) {
              console.warn(`Error processing ${full}:`, err.message);
            }
          }
        } catch (err) {
          console.error(`Error reading directory ${dir}:`, err.message);
        }
      }

      if (!root || !fs.existsSync(root)) {
        throw new Error('Root directory does not exist or is not provided');
      }

      scanVideos(root);
      const audioDirs = scanAudioDirs(root);
      return { videos, audioDirs };
    } catch (err) {
      console.error('Error in scanFolders:', err.message);
      return { videos: [], audioDirs: [] };
    }
  },
  	startMerge: ({ root, mkvmergePath, videos, selectedAudioDirs }) => {
		try {
			// Сбрасываем флаг отмены и очищаем активные процессы
			isCancelled = false;
			activeProcesses.clear();
			
			if (!root || !fs.existsSync(root)) {
				throw new Error('Root directory does not exist');
			}
			
			if (!mkvmergePath || !fs.existsSync(mkvmergePath)) {
				throw new Error('mkvmerge executable not found');
			}
			
			const rootName = path.basename(root);
			const outputDir = path.join(root, rootName);
			
			// Очищаем папку вывода перед началом объединения
			if (fs.existsSync(outputDir)) {
				try {
					const files = fs.readdirSync(outputDir);
					for (const file of files) {
						const filePath = path.join(outputDir, file);
						const stat = fs.statSync(filePath);
						if (stat.isFile()) {
							fs.unlinkSync(filePath);
							console.log(`Deleted old file: ${filePath}`);
						}
					}
					console.log(`Cleared output directory: ${outputDir}`);
				} catch (err) {
					console.warn(`Warning: Could not clear output directory: ${err.message}`);
				}
			} else {
				try {
					fs.mkdirSync(outputDir, { recursive: true });
				} catch (err) {
					throw new Error(`Failed to create output directory: ${err.message}`);
				}
			}
			
			const exts = ['.ac3', '.dts', '.flac', '.mka', '.wav', '.aac'];
			
						// Получаем аудио файлы из каждой папки в правильном порядке
			const audioFilesByDir = [];
      selectedAudioDirs.forEach(dirPath => {
				// Поддерживаем как старый формат (строка), так и новый (объект)
				const dir = typeof dirPath === 'string' ? dirPath : dirPath.path;
				try {
					if (!fs.existsSync(dir)) {
						console.warn(`Audio directory does not exist: ${dir}`);
						audioFilesByDir.push([]);
						return;
					}
					
					const files = fs.readdirSync(dir)
						.filter(f => exts.includes(path.extname(f).toLowerCase()))
						.sort() // сортируем файлы в папке
						.map(f => path.join(dir, f))
						.filter(f => fs.existsSync(f));
					
					audioFilesByDir.push(files);
					console.log(`Found ${files.length} audio files in ${dir}`);
				} catch (err) {
					console.error(`Error reading audio directory ${dir}:`, err.message);
					audioFilesByDir.push([]);
				}
			});
			
			// Функция для обработки одного видео
			const processVideo = (video, videoIndex, audioFilesByDir) => {
				return new Promise((resolve) => {
					try {
						// Проверяем, не отменен ли процесс
						if (isCancelled) {
							console.log(`Skipping video ${videoIndex + 1} - process cancelled`);
							resolve();
							return;
						}
						
						if (!fs.existsSync(video)) {
							console.warn(`Video file does not exist: ${video}`);
							ipcRenderer.send('merge-complete', { videoIndex, success: false, error: 'Файл не найден' });
							resolve();
							return;
						}
						
						let audioFiles = [];
						
						// Для каждой выбранной аудио папки берем файл с индексом videoIndex
						audioFilesByDir.forEach((dirFiles, dirIndex) => {
							if (dirFiles.length > videoIndex) {
								audioFiles.push(dirFiles[videoIndex]);
								console.log(`Video ${videoIndex + 1}: using audio file ${dirFiles[videoIndex]} from dir ${dirIndex + 1}`);
							} else {
								console.warn(`Video ${videoIndex + 1}: no corresponding audio file in dir ${dirIndex + 1} (has only ${dirFiles.length} files)`);
							}
						});
						
						if (!audioFiles.length) {
							console.warn(`No audio files found for video ${videoIndex + 1}: ${video}`);
							ipcRenderer.send('merge-complete', { videoIndex, success: false, error: 'Аудио файлы не найдены' });
							resolve();
							return;
						}
						
						const videoBaseName = path.basename(video, '.mkv');
						const out = path.join(outputDir, `${videoBaseName}_merged.mkv`);
						// Исправляем аргументы mkvmerge - правильный порядок
						const args = ['-o', out, '--gui-mode', '--no-audio', video].concat(audioFiles);
						
						console.log(`Starting merge for video ${videoIndex + 1}: ${video}`);
						console.log(`Audio files: ${audioFiles.join(', ')}`);
						console.log(`Output: ${out}`);
						console.log(`mkvmerge command: ${mkvmergePath} ${args.join(' ')}`);
						
						// Проверяем существование mkvmerge
						if (!fs.existsSync(mkvmergePath)) {
							console.error(`mkvmerge not found at: ${mkvmergePath}`);
							ipcRenderer.send('merge-complete', { videoIndex, success: false, error: 'mkvmerge не найден' });
							resolve();
							return;
						}
						
						// Отправляем событие начала обработки
						ipcRenderer.send('merge-progress', { 
							videoIndex, 
							progress: 0, 
							status: 'processing', 
							statusText: 'Начинаем обработку...' 
						});
						
						const mkv = spawn(mkvmergePath, args, {
							stdio: ['pipe', 'pipe', 'pipe']
						});
						
						// Сохраняем процесс для возможности отмены
						activeProcesses.set(videoIndex, mkv);
						let lastProgress = 0;
						
						mkv.on('error', (err) => {
							console.error(`Failed to start mkvmerge process for ${video}: ${err.message}`);
							activeProcesses.delete(videoIndex);
							ipcRenderer.send('merge-complete', { videoIndex, success: false, error: err.message });
							resolve();
						});
						
						mkv.on('close', code => {
							// Удаляем процесс из активных
							activeProcesses.delete(videoIndex);
							
							if (isCancelled) {
								console.log(`Process for video ${videoIndex + 1} was cancelled`);
								resolve();
								return;
							}
							
							if (code === 0) {
								console.log(`✓ Successfully merged video ${videoIndex + 1}: ${video}`);
								ipcRenderer.send('merge-progress', { 
									videoIndex, 
									progress: 100, 
									status: 'completed', 
									statusText: 'Завершено' 
								});
								ipcRenderer.send('merge-complete', { videoIndex, success: true });
							} else {
								console.error(`✗ Failed to merge video ${videoIndex + 1}: ${video} (exit code: ${code})`);
								let errorMessage = `Код ошибки: ${code}`;
								if (code === 2) {
									errorMessage = 'Ошибка аргументов mkvmerge. Проверьте пути к файлам.';
								} else if (code === 1) {
									errorMessage = 'Предупреждения при обработке, но файл создан.';
								}
								ipcRenderer.send('merge-complete', { videoIndex, success: false, error: errorMessage });
							}
							resolve();
						});
						
						mkv.stderr.on('data', (data) => {
							const output = data.toString();
							console.log(`mkvmerge stderr for video ${videoIndex + 1}: ${output}`);
							
							// Проверяем на ошибки в выводе
							if (output.toLowerCase().includes('error') || output.toLowerCase().includes('failed')) {
								console.error(`Error detected in mkvmerge output: ${output}`);
							}
							
							// Улучшенный парсинг прогресса
							const progressPatterns = [
								/#GUI#progress (\d+)%/,
								/Progress: (\d+)%/,
								/(\d+)%/,
								/\[(\d+)%\]/,
								/Processing: (\d+)%/
							];

							for (const pattern of progressPatterns) {
								const match = output.match(pattern);
								if (match) {
									const progress = parseInt(match[1]);
									if (progress > lastProgress) {
										lastProgress = progress;
										ipcRenderer.send('merge-progress', {
											videoIndex,
											progress,
											status: 'processing',
											statusText: 'Обработка...',
										});
									}
									break;
								}
							}
						});
						
						mkv.stdout.on('data', (data) => {
							const output = data.toString();
							console.log(`mkvmerge stdout for ${video}: ${output}`);
							
							// Парсим прогресс из stdout тоже
							const progressPatterns = [
								/#GUI#progress (\d+)%/,
								/Progress: (\d+)%/,
								/(\d+)%/,
								/\[(\d+)%\]/,
								/Processing: (\d+)%/
							];
							
							for (const pattern of progressPatterns) {
								const match = output.match(pattern);
								if (match) {
									console.info('MATCH', match);
									const progress = parseInt(match[1]);
									if (progress > lastProgress) {
										lastProgress = progress;
										ipcRenderer.send('merge-progress', {
											videoIndex,
											progress,
											status: 'processing',
											statusText: 'Обработка...',
										});
									}
									break;
								}
							}
						});
						
					} catch (err) {
						console.error(`Error processing video ${videoIndex + 1} (${video}):`, err.message);
						ipcRenderer.send('merge-complete', { videoIndex, success: false, error: err.message });
						resolve();
					}
				});
			};

			// Функция для обработки видео с ограничением параллельности
			const processVideosWithLimit = async (videos, audioFilesByDir, maxConcurrent = MAX_CONCURRENT_PROCESSES) => {
				const results = [];
				const executing = [];
				
				for (let i = 0; i < videos.length; i++) {
					const video = videos[i];
					
					// Создаем промис для обработки видео
					const promise = processVideo(video, i, audioFilesByDir).then(() => {
						// Удаляем завершенный промис из списка выполняющихся
						executing.splice(executing.indexOf(promise), 1);
					});
					
					results.push(promise);
					executing.push(promise);
					
					// Если достигли лимита параллельности, ждем завершения одного из процессов
					if (executing.length >= maxConcurrent) {
						await Promise.race(executing);
					}
				}
				
				// Ждем завершения всех оставшихся процессов
				await Promise.all(results);
			};

			// Запускаем обработку с ограничением параллельности
			processVideosWithLimit(videos, audioFilesByDir, MAX_CONCURRENT_PROCESSES);
			
			console.log(`Started merging ${videos.length} videos with audio from ${selectedAudioDirs.length} directories`);
			
		} catch (err) {
			console.error('Error in merge:', err.message);
		}
	}
});