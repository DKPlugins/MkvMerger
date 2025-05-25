window.addEventListener('DOMContentLoaded', () => {
	// Константы
	const MAX_CONCURRENT_PROCESSES = 2;
	
	const btnBrowse = document.getElementById('btnBrowse');
	const mkvmergeButton = document.getElementById('mkvmergeButton');
	const mkvmergeStatus = document.getElementById('mkvmergeStatus');
	const audioGrid = document.getElementById('audioGrid');
	const videoGrid = document.getElementById('videoGrid');
	const btnMerge = document.getElementById('btnMerge');
	let state = { root: null, videos: [], audioDirs: [], selectedOrder: [], mkvmergePath: null };
  
	// Проверяем доступность API
	if (!window.api) {
		console.error('API not available - preload script may have failed to load');
		alert('Ошибка: API недоступен. Проверьте консоль для деталей.');
		return;
	}

	// Функция для обновления статуса mkvmerge
	const updateMkvMergeStatus = async (path = null) => {
		if (!path) {
			mkvmergeButton.className = 'mkvmerge-button invalid';
			mkvmergeButton.innerHTML = '❌';
			mkvmergeStatus.className = 'mkvmerge-status invalid';
			mkvmergeStatus.textContent = 'Не выбран';
			state.mkvmergePath = null;
			updateMergeButton();
			return;
		}

		mkvmergeButton.className = 'mkvmerge-button checking';
		mkvmergeButton.innerHTML = '⏳';
		mkvmergeStatus.className = 'mkvmerge-status checking';
		mkvmergeStatus.textContent = 'Проверяем...';

		try {
			const exists = await window.api.checkFileExists(path);
			if (exists) {
				mkvmergeButton.className = 'mkvmerge-button valid';
				mkvmergeButton.innerHTML = '✅';
				mkvmergeStatus.className = 'mkvmerge-status valid';
				mkvmergeStatus.textContent = 'Найден';
				state.mkvmergePath = path;
				console.log(`Found mkvmerge at: ${path}`);
			} else {
				mkvmergeButton.className = 'mkvmerge-button invalid';
				mkvmergeButton.innerHTML = '❌';
				mkvmergeStatus.className = 'mkvmerge-status invalid';
				mkvmergeStatus.textContent = 'Не найден';
				state.mkvmergePath = null;
			}
		} catch (error) {
			console.warn(`Could not check path ${path}:`, error);
			mkvmergeButton.className = 'mkvmerge-button invalid';
			mkvmergeButton.innerHTML = '❌';
			mkvmergeStatus.className = 'mkvmerge-status invalid';
			mkvmergeStatus.textContent = 'Ошибка проверки';
			state.mkvmergePath = null;
		}
		
		updateMergeButton();
	};

	// Проверяем и устанавливаем путь к mkvmerge при загрузке
	const checkMkvMergePath = async () => {
		const commonPaths = [
			'C:\\Program Files\\MKVToolNix\\mkvmerge.exe',
			'C:\\Program Files (x86)\\MKVToolNix\\mkvmerge.exe',
			'mkvmerge.exe' // если в PATH
		];

		for (const path of commonPaths) {
			try {
				const exists = await window.api.checkFileExists(path);
				if (exists) {
					await updateMkvMergeStatus(path);
					return;
				}
			} catch (error) {
				console.warn(`Could not check path ${path}:`, error);
			}
		}
		
		// Если ничего не найдено
		await updateMkvMergeStatus(null);
	};

	// Проверяем путь при загрузке страницы
	checkMkvMergePath();

	// Обработчики событий прогресса
	window.api.onMergeProgress((data) => {
		const { videoIndex, progress, status, statusText } = data;
		updateVideoProgress(videoIndex, progress, status, statusText);
		
		// Если файл начал обрабатываться, обновляем статусы следующих файлов в очереди
		if (status === 'processing' && progress > 0) {
			const completedCount = document.querySelectorAll('.video-card.status-completed, .video-card.status-error').length;
			const processingCount = document.querySelectorAll('.video-card.status-processing').length;
			
			// Обновляем статусы файлов в очереди
			state.videos.forEach((video, index) => {
				const videoCard = document.querySelector(`[data-video-index="${index}"]`);
				if (videoCard && videoCard.classList.contains('status-idle')) {
					if (completedCount + processingCount < MAX_CONCURRENT_PROCESSES) {
						updateVideoProgress(index, 0, 'processing', 'В очереди...');
					}
				}
			});
		}
	});

	window.api.onMergeComplete((data) => {
		const { videoIndex, success, error } = data;
		if (success) {
			updateVideoProgress(videoIndex, 100, 'completed', 'Завершено');
		} else {
			updateVideoProgress(videoIndex, 0, 'error', error || 'Ошибка');
		}
		
		// Обновляем общий прогресс
		const completedCount = document.querySelectorAll('.video-card.status-completed, .video-card.status-error').length;
		showOverallProgress(completedCount, state.videos.length);
		
		// Обновляем статусы следующих файлов в очереди
		const processingCount = document.querySelectorAll('.video-card.status-processing').length;
		if (processingCount < MAX_CONCURRENT_PROCESSES) {
			state.videos.forEach((video, index) => {
				const videoCard = document.querySelector(`[data-video-index="${index}"]`);
				if (videoCard && videoCard.classList.contains('status-idle')) {
					updateVideoProgress(index, 0, 'processing', 'В очереди...');
					return; // Обновляем только один файл за раз
				}
			});
		}
		
		// Если все файлы обработаны, разблокируем кнопку
		if (completedCount === state.videos.length) {
			btnMerge.disabled = false;
			btnMerge.textContent = 'Merge';
		}
	});

	// Функции для drag & drop
	let draggedElement = null;

	function handleDragStart(e) {
		draggedElement = this;
		this.classList.add('dragging');
		e.dataTransfer.effectAllowed = 'move';
		e.dataTransfer.setData('text/html', this.outerHTML);
	}

	function handleDragOver(e) {
		if (e.preventDefault) {
			e.preventDefault();
		}
		e.dataTransfer.dropEffect = 'move';
		return false;
	}

	function handleDrop(e) {
		if (e.stopPropagation) {
			e.stopPropagation();
		}

		if (draggedElement !== this) {
			const allCards = Array.from(audioGrid.children).filter(child => child.classList.contains('folder-card'));
			const draggedIndex = allCards.indexOf(draggedElement);
			const targetIndex = allCards.indexOf(this);

			if (draggedIndex < targetIndex) {
				this.parentNode.insertBefore(draggedElement, this.nextSibling);
			} else {
				this.parentNode.insertBefore(draggedElement, this);
			}

			updateSelectedOrder();
			updateOrderNumbers();
		}

		return false;
	}

	function handleDragEnd(e) {
		this.classList.remove('dragging');
		draggedElement = null;
	}

	function updateSelectedOrder() {
		if (!audioGrid) return;
		
		state.selectedOrder = [];
		const cards = audioGrid.querySelectorAll('.folder-card.selected');
		cards.forEach(card => {
			state.selectedOrder.push(card.dataset.dir);
		});
		
		updateOrderNumbers();
		console.log('Selected order:', state.selectedOrder);
	}

	function updateOrderNumbers() {
		if (!audioGrid) return;
		
		let orderIndex = 1;
		const cards = audioGrid.querySelectorAll('.folder-card');
		cards.forEach(card => {
			let orderSpan = card.querySelector('.order-number');
			
			if (card.classList.contains('selected')) {
				if (!orderSpan) {
					orderSpan = document.createElement('span');
					orderSpan.className = 'order-number';
					card.appendChild(orderSpan);
				}
				orderSpan.textContent = orderIndex++;
				orderSpan.style.display = 'flex';
			} else {
				if (orderSpan) {
					orderSpan.style.display = 'none';
				}
			}
		});
		
		// Обновляем состояние кнопки Merge
		updateMergeButton();
	}

	function updateMergeButton() {
		const hasSelectedFolders = state.selectedOrder.length > 0;
		const hasVideos = state.videos.length > 0;
		const hasMkvMerge = state.mkvmergePath !== null;
		
		btnMerge.disabled = !(hasSelectedFolders && hasVideos && hasMkvMerge);
	}

	// Функции для управления прогрессом
	function updateVideoProgress(videoIndex, progress, status, statusText) {
		const videoCard = document.querySelector(`[data-video-index="${videoIndex}"]`);
		if (!videoCard) return;

		const progressDiv = videoCard.querySelector('.video-progress');
		const progressFill = videoCard.querySelector('.progress-fill');
		const progressPercent = videoCard.querySelector('.progress-percent');
		const statusTextSpan = videoCard.querySelector('.status-text');

		// Показываем прогресс
		progressDiv.style.display = 'block';
		
		// Обновляем статус
		videoCard.className = `video-card status-${status}`;
		
		// Обновляем прогресс
		progressFill.style.width = `${progress}%`;
		progressPercent.textContent = `${progress}%`;
		statusTextSpan.textContent = statusText;
	}

	function resetAllProgress() {
		const videoCards = document.querySelectorAll('.video-card');
		videoCards.forEach(card => {
			card.className = 'video-card status-idle';
			const progressDiv = card.querySelector('.video-progress');
			if (progressDiv) {
				progressDiv.style.display = 'none';
			}
		});
		
		const progressSummary = document.getElementById('progressSummary');
		progressSummary.style.display = 'none';
	}

	function showOverallProgress(completed, total) {
		const progressSummary = document.getElementById('progressSummary');
		const overallProgress = document.getElementById('overallProgress');
		
		progressSummary.style.display = 'block';
		const percentage = Math.round((completed / total) * 100);
		overallProgress.innerHTML = `
			<strong>Общий прогресс:</strong> ${completed} из ${total} файлов (${percentage}%)
			<div class="progress-bar" style="margin-top:5px;">
				<div class="progress-fill" style="width:${percentage}%"></div>
			</div>
		`;
	}

	// Обработчик для выбора файла mkvmerge
	mkvmergeButton.addEventListener('click', async () => {
		try {
			const filePath = await window.api.selectMkvMergeFile();
			if (filePath) {
				await updateMkvMergeStatus(filePath);
				console.log(`Selected mkvmerge: ${filePath}`);
			}
		} catch (error) {
			console.error('Error selecting mkvmerge file:', error);
			alert(`Ошибка при выборе файла: ${error.message}`);
		}
	});
  
	btnBrowse.addEventListener('click', async () => {
		try {
			btnBrowse.disabled = true;
			btnBrowse.textContent = 'Выбираем папку...';
			
			const root = await window.api.selectRoot();
			if (!root) {
				btnBrowse.disabled = false;
				btnBrowse.textContent = 'Select Root Folder';
				return;
			}
			
			// Если выбрана новая папка, сбрасываем все
			if (state.root && state.root !== root) {
				resetAllProgress();
				state.selectedOrder = [];
			}
			
			state.root = root;
			
			// Показываем выбранную папку
			const selectedFolderDiv = document.getElementById('selectedFolder');
			const folderPathSpan = document.getElementById('folderPath');
			folderPathSpan.textContent = root;
			selectedFolderDiv.style.display = 'block';
			audioGrid.innerHTML = '<div class="empty-state">Сканируем аудио папки...</div>';
			videoGrid.innerHTML = '<div class="empty-state">Сканируем видео файлы...</div>';
			
			const { videos, audioDirs } = window.api.scanFolders(root);
			state.videos = videos.sort(); // сортируем видео по имени
			state.audioDirs = audioDirs.sort(); // сортируем аудио папки по имени
			state.selectedOrder = [];
			
			// Очищаем и заполняем аудио папки
			audioGrid.innerHTML = '';
			
			if (audioDirs.length === 0) {
				audioGrid.innerHTML = '<div class="empty-state">Аудио папки не найдены</div>';
			} else {
				audioDirs.forEach((dirInfo, index) => {
					const dir = dirInfo.path || dirInfo; // поддержка старого формата
					const fileCount = dirInfo.fileCount || 0;
					const rel = dir.slice(root.length + 1) || dir;
					const folderName = dir.split(/[/\\]/).pop();
					
					const folderCard = document.createElement('div');
					folderCard.className = 'folder-card';
					folderCard.draggable = false;
					folderCard.dataset.dir = dir;
					folderCard.innerHTML = `
						<div class="folder-header">
							<span class="drag-handle">⋮⋮⋮</span>
						</div>
						<div class="folder-name">${folderName}</div>
						<div class="folder-path" title="${dir}">${rel}</div>
						<div class="folder-count">${fileCount} файлов</div>
					`;
					audioGrid.appendChild(folderCard);
					
					// Добавляем обработчик клика для выбора/отмены выбора
					folderCard.addEventListener('click', (e) => {
						// Не обрабатываем клик по drag handle
						if (e.target.classList.contains('drag-handle')) {
							return;
						}
						
						folderCard.classList.toggle('selected');
						updateSelectedOrder();
					});
					
					// Добавляем обработчики drag & drop только к drag handle
					const dragHandle = folderCard.querySelector('.drag-handle');
					dragHandle.addEventListener('mousedown', (e) => {
						folderCard.draggable = true;
					});
					
					folderCard.addEventListener('dragstart', handleDragStart);
					folderCard.addEventListener('dragover', handleDragOver);
					folderCard.addEventListener('drop', handleDrop);
					folderCard.addEventListener('dragend', (e) => {
						handleDragEnd.call(folderCard, e);
						folderCard.draggable = false;
					});
				});
			}
			
			// Очищаем и заполняем видео файлы
			videoGrid.innerHTML = '';
			
			// Обновляем заголовок с количеством файлов
			const videoHeader = document.getElementById('videoHeader');
			if (videoHeader) {
				videoHeader.textContent = `🎬 Video Files (${videos.length})`;
			}
			
			if (videos.length === 0) {
				videoGrid.innerHTML = '<div class="empty-state">MKV файлы не найдены</div>';
			} else {
				videos.forEach((v, index) => {
					const rel = v.slice(root.length + 1) || v;
					const fileName = v.split(/[/\\]/).pop();
					const videoCard = document.createElement('div');
					videoCard.className = 'video-card status-idle';
					videoCard.dataset.videoPath = v;
					videoCard.dataset.videoIndex = index;
					videoCard.innerHTML = `
						<div class="video-name">${fileName}</div>
						<div class="video-path" title="${v}">${rel}</div>
						<div class="video-progress" style="display:none;">
							<div class="progress-bar">
								<div class="progress-fill" style="width:0%"></div>
							</div>
							<div class="progress-text">
								<span class="status-text">Ожидание...</span>
								<span class="progress-percent">0%</span>
							</div>
						</div>
					`;
					videoGrid.appendChild(videoCard);
				});
			}
			
			console.log(`Найдено ${videos.length} видео файлов и ${audioDirs.length} аудио папок`);
			
			// Обновляем состояние кнопки Merge
			updateMergeButton();
			
		} catch (error) {
			console.error('Error in browse:', error);
			alert(`Ошибка при выборе папки: ${error.message}`);
			audioGrid.innerHTML = '<div class="empty-state" style="color: red;">Ошибка сканирования аудио папок</div>';
			videoGrid.innerHTML = '<div class="empty-state" style="color: red;">Ошибка сканирования видео файлов</div>';
		} finally {
			btnBrowse.disabled = false;
			btnBrowse.textContent = 'Select Root Folder';
		}
	});
  
	btnMerge.addEventListener('click', () => {
		try {
			if (!state.root) {
				alert('Сначала выберите папку');
				return;
			}
			
			if (!state.mkvmergePath) {
				alert('Выберите файл mkvmerge.exe');
				return;
			}
			
			if (state.selectedOrder.length === 0) {
				alert('Выберите хотя бы одну аудио папку');
				return;
			}
			
			if (state.videos.length === 0) {
				alert('Видео файлы не найдены');
				return;
			}
			
			btnMerge.disabled = true;
			btnMerge.textContent = 'Объединяем...';
			
			// Сбрасываем прогресс
			resetAllProgress();
			
			// Показываем начальный прогресс
			showOverallProgress(0, state.videos.length);
			
			// Инициализируем прогресс для всех видео
			state.videos.forEach((video, index) => {
				if (index < MAX_CONCURRENT_PROCESSES) {
					updateVideoProgress(index, 0, 'processing', 'В очереди...');
				} else {
					updateVideoProgress(index, 0, 'idle', 'Ожидание очереди...');
				}
			});
			
			// Запускаем объединение
			window.api.startMerge({ 
				root: state.root, 
				mkvmergePath: state.mkvmergePath, 
				videos: state.videos, 
				selectedAudioDirs: state.selectedOrder 
			});
			
			console.log(`Начато объединение ${state.videos.length} файлов с аудио из ${state.selectedOrder.length} папок`);
			
		} catch (error) {
			console.error('Error in merge:', error);
			alert(`Ошибка при объединении: ${error.message}`);
			btnMerge.disabled = false;
			btnMerge.textContent = 'Merge';
		}
	});
});