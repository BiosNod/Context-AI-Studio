const fs = require('fs');
const path = require('path');
const gui = require('nw.gui');

let projectPath = '';
let editor = ace.edit("editor");
editor.setTheme("ace/theme/monokai");
editor.session.setMode("ace/mode/javascript");
editor.setFontSize(16);
editor.setOption("fontSize", 16);

let templates = {};
// Глобальный объект для хранения соответствия путей и узлов
let pathToNodeMap = {};

let treeElement = $('#file-tree');
let treeInstance;
let currentOpenedFile = '';
let currentWatcher = null;


function convertSpacesToTabs(content) {
	return content.replace(/ {2}/g, '\t');
}

function processContent(content, options = {}) {
	let processedContent = content;

	// Delete commits if enabled
	if (options.removeSingle || options.removeMulti) {
		processedContent = removeComments(processedContent, options.removeSingle, options.removeMulti);
	}

	// Replace spaces if enabled
	if (options.convertSpacesToTabs) {
		processedContent = convertSpacesToTabs(processedContent);
	}

	return processedContent;
}

function removeComments(content, removeSingle = false, removeMulti = false) {
	//If no one from flags selected - return content without changes
	if (!removeSingle && !removeMulti) {
		return content;
	}

	let processedContent = content;

	if (removeMulti) {
		// Replace multiline commits and and keep original line structure
		processedContent = processedContent.replace(/'''[\s\S]*?'''|"""[\s\S]*?"""/g, match =>
			match.split('\n').map(() => '').join('\n')
		);
		processedContent = processedContent.replace(/\/\*[\s\S]*?\*\//g, match =>
			match.split('\n').map(() => '').join('\n')
		);
	}

	if (removeSingle) {
		// Process line by line
		const lines = processedContent.split('\n');
		const processedLines = lines.map(line => {
			const trimmedLine = line.trim();

			// If string starts with comment - return empty string
			if (trimmedLine.startsWith('#') || trimmedLine.startsWith('//')) {
				return '';
			}

			// Remove inline comments and keep code before
			return line.replace(/(?:^|\s)(\/\/|#).*$/, '').trimRight();
		});

		// Join lines and keep next lines
		processedContent = processedLines.join('\n');
	}

	// Fix moments where is 3+ next lines due to deletions
	processedContent = processedContent
		// 3+ next lines replace to 2
		.replace(/\n\n\n+/g, '\n\n');

	return processedContent;
}

function getDirectoryStructure(dir) {
	function readDir(currentDir) {
		let files;
		try {
			files = fs.readdirSync(currentDir);
		} catch (error) {
			console.error(`Error reading directory ${currentDir}:`, error);
			return [];
		}

		return files.map(file => {
			const filePath = path.join(currentDir, file);

			// Игнорируем папку node_modules
			if (file === 'node_modules') {
				return null;
			}

			let stats;
			try {
				stats = fs.statSync(filePath);
			} catch (error) {
				console.error(`Error getting file info ${filePath}:`, error);
				return null;
			}

			if (stats.isDirectory()) {
				return {
					text: file,
					children: readDir(filePath),
					path: filePath,
					type: 'folder',
					icon: 'bi bi-folder'
				};
			} else {
				return {
					text: file,
					path: filePath,
					type: 'file',
					icon: 'bi bi-file-earmark'
				};
			}
		}).filter(item => item !== null);
	}

	return readDir(dir);
}

function get_node_by_path(fullPath) {
	console.log('Searching for node with path:', fullPath);

	// Возвращаем узел из хэш-таблицы
	const nodeId = pathToNodeMap[fullPath];

	if (nodeId)
		return treeInstance.get_node(nodeId);
}

function get_node_by_path_manual(fullPath) {
	console.log('Searching for node with path:', fullPath);
	let node = null;

	// Получаем все узлы дерева
	const allNodes = treeInstance.get_json('#', { flat: true });
	console.log('All nodes:', allNodes);

	// Ищем узел с нужным путём
	for (let i = 0; i < allNodes.length; i++) {
		const nodeId = allNodes[i].id;
		const fullNode = treeInstance.get_node(nodeId); // Получаем полный объект узла
		console.log('Checking node:', fullNode);

		if (fullNode.original && fullNode.original.path === fullPath) {
			node = fullNode;
			break; // Прерываем цикл, если узел найден
		}
	}
	console.log('Found node:', node);
	return node;
}

function updateFileTree() {
	if (!projectPath) return;
	const structure = getDirectoryStructure(projectPath);

	// Очищаем хэш-таблицу перед обновлением дерева
	pathToNodeMap = {};

	if (treeInstance)
		treeElement.jstree('destroy');

	treeElement.jstree({
		core: {
			data: structure,
			themes: {
				name: 'default-dark',
				dots: false,
				icons: true
			},
			check_callback: true
		},
		// Register plugins here
		plugins: ['checkbox', 'types', 'path'],
		types: {
			file: {
				icon: 'bi bi-file-earmark'
			},
			folder: {
				icon: 'bi bi-folder'
			}
		},
		checkbox: {
			three_state: true,
			whole_node: false,
			tie_selection: false
		}
	});

	treeInstance = treeElement.jstree(true);

	treeElement.on('changed.jstree', (e, data) => {
		if (data.node && data.node.type === 'file') {
			currentOpenedFile = data.node.original.path;

			const watcher = fs.watch(currentOpenedFile, (eventType, filename) => {
				if (eventType === 'change') {
					updateFileContent(currentOpenedFile);
				}
			});

			openFile(data.node.original.path);
		}
		updateTokenCount();
	});

	treeElement.on('check_node.jstree uncheck_node.jstree', (e, data) => {
		updateTokenCount();
	});

	// Load templates and first template after full tree initialization
	treeElement.on('ready.jstree', function() {
		console.log('Tree is ready');

		const allNodes = treeInstance.get_json('#', { flat: true });

		allNodes.forEach(node => {
			const fullNode = treeInstance.get_node(node.id);
			if (fullNode.original && fullNode.original.path) {
				pathToNodeMap[fullNode.original.path] = node.id; // Сохраняем узел в хэш-таблицу
				console.info(`Add node, id: ${node.id}, node: ${node}`)
			}
		});

		loadTemplatesFromFile();
		loadFirstTemplate();
	});
}

// Load first available project template
function loadFirstTemplate() {
	const templateNames = Object.keys(templates);
	if (templateNames.length > 0) {
		const firstTemplateName = templateNames[0];
		$('#template-select').val(firstTemplateName);
		console.log('Loading first template:', firstTemplateName);
		loadTemplate(firstTemplateName);
	} else {
		console.log('No templates available');
	}
}

function loadTemplatesFromFile() {
	const filePath = path.join(projectPath, 'ai.context.json');
	if (fs.existsSync(filePath)) {
		templates = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		updateTemplateSelect();
	}
}

function loadTemplate(templateName) {
	templateName = templateName || $('#template-select').val();
	if (!templateName) return;
	const template = templates[templateName];
	if (template) {
		treeElement.jstree('uncheck_all');

		// Iteration on nodes and get full path for each file
		treeInstance.get_json('#', { flat: true }).forEach(function (node) {
			// Get node from get_node to access to original
			let fullNode = treeInstance.get_node(node.id);
			let relativePath = getRelativePath(fullNode.original.path)
			console.log(relativePath);
			if (template.includes(relativePath))
				treeElement.jstree('check_node', node);
		});

		updateTokenCount();
	}
}

function openFile(filePath) {
	fs.readFile(filePath, 'utf8', (err, content) => {
		if (err) {
			console.error('Error reading file:', err);
			return;
		}
		editor.setValue(content);
		editor.clearSelection();

		const extension = path.extname(filePath).slice(1);
		const mode = getAceMode(extension);
		editor.session.setMode(`ace/mode/${mode}`);

		$('#lang-select').val(mode);
	});
}

function getAceMode(extension) {
	const modeMap = {
		'js': 'javascript',
		'py': 'python',
		'html': 'html',
		'css': 'css',
		'java': 'java',
		'cpp': 'c_cpp',
		'c': 'c_cpp',
		'rb': 'ruby',
		'php': 'php',
		'json': 'json',
		'xml': 'xml',
		'md': 'markdown',
		'sql': 'sql',
		'sh': 'sh',
		'yaml': 'yaml',
		'yml': 'yaml',
		'txt': 'text'
	};
	return modeMap[extension] || 'text';
}

const languages = ['javascript', 'python', 'html', 'css', 'java', 'c_cpp', 'ruby', 'php', 'json', 'xml', 'markdown', 'sql', 'sh', 'yaml', 'text'];
languages.forEach(lang => {
	$('#lang-select').append($('<option>', {
		value: lang,
		text: lang.charAt(0).toUpperCase() + lang.slice(1)
	}));
});

function updateTokenCount() {
	const selectedNodes = treeElement.jstree('get_checked', true);
	let tokenCount = 0;
	let totalSize = 0;

	const options = {
		removeSingle: $('#remove-single-comments').is(':checked'),
		removeMulti: $('#remove-multi-comments').is(':checked'),
		convertSpacesToTabs: $('#convert-spaces-to-tabs').is(':checked')
	};

	selectedNodes.forEach(node => {
		if (node.type === 'file') {
			let content = fs.readFileSync(node.original.path, 'utf8');
			content = processContent(content, options);
			tokenCount += content.split(/\s+/).filter(token => token.length > 0).length;
			totalSize += Buffer.from(content).length;
		}
	});

	$('#token-count').text(`${tokenCount} (${formatFileSize(totalSize)})`);
}

function formatFileSize(bytes) {
	if (bytes < 1024) return bytes + ' B';
	else if (bytes < 1048576) return (bytes / 1024).toFixed(2) + ' KB';
	else if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
	else return (bytes / 1073741824).toFixed(2) + ' GB';
}

function getFileSize(filePath) {
	const stats = fs.statSync(filePath);
	return stats.size;
}

function getRelativePath(fullPath) {
	return path.relative(projectPath, fullPath);
}

function saveTemplate() {
	const currentTemplate = $('#template-select').val();
	const name = prompt('Enter template name:', currentTemplate || '');
	if (!name) return;

	const selectedNodes = treeElement.jstree('get_checked', true);
	const template = selectedNodes.map(node => getRelativePath(node.original.path));
	templates[name] = template;
	updateTemplateSelect();
	saveTemplateToFile(name, template);
	$('#template-select').val(name);
}

function editTemplate() {
	const currentTemplate = $('#template-select').val();
	if (!currentTemplate) {
		alert('Please select a template to edit');
		return;
	}
	const newName = prompt('Enter new template name:', currentTemplate);
	if (!newName || newName === currentTemplate) return;

	const templateIndex = templates.findIndex(t => t.name === currentTemplate);
	if (templateIndex !== -1) {
		templates[templateIndex].name = newName;
		updateTemplateSelect();
		// Update file with templates
		const filePath = path.join(projectPath, 'ai.context.json');
		if (fs.existsSync(filePath)) {
			let fileTemplates = JSON.parse(fs.readFileSync(filePath, 'utf8'));
			if (fileTemplates[currentTemplate]) {
				fileTemplates[newName] = fileTemplates[currentTemplate];
				delete fileTemplates[currentTemplate];
				fs.writeFileSync(filePath, JSON.stringify(fileTemplates, null, 2));
			}
		}
		// Choosing edited template
		$('#template-select').val(newName);
	}
}

function deleteTemplate() {
	const templateName = $('#template-select').val();
	if (!templateName) return;
	if (!confirm(`Are you sure you want to delete template "${templateName}"?`)) return;

	console.log('Templates before deleting', templates)
	delete templates[templateName];
	updateTemplateSelect();
	deleteTemplateFromFile(templateName);
}

function updateTemplateSelect() {
	const $select = $('#template-select');
	$select.empty();
	$select.append($('<option>', {value: '', text: 'Select Template'}));
	Object.keys(templates).forEach(templateName => {
		$select.append($('<option>', {value: templateName, text: templateName}));
	});
}

function saveTemplateToFile(templateName, template) {
	const filePath = path.join(projectPath, 'ai.context.json');
	let templates = {};
	if (fs.existsSync(filePath)) {
		templates = JSON.parse(fs.readFileSync(filePath, 'utf8'));
	}
	templates[templateName] = template;
	fs.writeFileSync(filePath, JSON.stringify(templates, null, 2));
}

function deleteTemplateFromFile(templateName) {
	const filePath = path.join(projectPath, 'ai.context.json');
	if (fs.existsSync(filePath)) {
		let templates = JSON.parse(fs.readFileSync(filePath, 'utf8'));
		delete templates[templateName];
		fs.writeFileSync(filePath, JSON.stringify(templates, null, 2));
	}
}

function watchProjectChanges() {
	if (!projectPath) return;

	// Закрываем предыдущий watcher, если он существует
	if (currentWatcher) {
		currentWatcher.close();
		currentWatcher = null;
	}

	// Создаем новый watcher
	currentWatcher = fs.watch(projectPath, { recursive: true }, (eventType, filename) => {
		if (!filename) return; // Игнорируем события без имени файла

		// Игнорируем изменения в .git и других системных папках
		if (filename.includes('.git') || filename.includes('node_modules')) {
			console.log(`Ignoring change in system directory: ${filename}`);
			return;
		}

		const fullPath = path.join(projectPath, filename);
		console.log(`Change detected: ${eventType} in ${filename}, fullPath: ${fullPath}`);
		// Ищем узел по полному пути
		const node = get_node_by_path(fullPath);

		// Добавляем задержку для обработки событий
		fs.stat(fullPath, (err, stats) => {
			if (err) {
				// Если файл/папка не существует, это событие удаления
				console.log(`File deleted: ${filename}`);
				updateTreeItem(fullPath, 'delete');
			} else if (node) {
				console.log(`File changed: ${filename}`);
				updateTreeItem(fullPath, 'change');
			} else {
				console.log(`File added: ${filename}`);
				updateTreeItem(fullPath, 'add');
			}
		});
	});

	currentWatcher.on('error', (error) => {
		console.error('Watcher error:', error);
	});
}

function updateTreeItem(fullPath, eventType) {
	if (!treeInstance) {
		console.error('jstree is not initialized');
		return;
	}

	console.log('updateTreeItem: ' + fullPath, 'event: ' + eventType);

	// Ищем узел по полному пути
	const node = get_node_by_path(fullPath);

	if (eventType === 'delete') {
		console.log('Deleting node:', node);
		treeInstance.delete_node(node);
		delete pathToNodeMap[fullPath];
	} else if (eventType === 'change') {
		console.log('Refreshing node:', node);
		treeInstance.refresh_node(node);
	} else if (eventType === 'add') {
		console.log('Node does not exist, adding new node');
		// Если узел не найден, это новый файл или папка
		const parentPath = path.dirname(fullPath);
		const parentNode = get_node_by_path(parentPath);

		if (parentNode) {
			console.log('Parent node found:', parentNode);
			// Создаём новый узел
			const newNode = createTreeNode(fullPath);

			// Добавляем новый узел в родительский узел
			const nodeId = treeInstance.create_node(parentNode, newNode, 'last', function (newNode) {
				console.log('Node added:', newNode);
				treeInstance.open_node(parentNode); // Раскрываем родительский узел
			});

			pathToNodeMap[fullPath] = nodeId;

		} else if (parentPath === projectPath) {
			// Если родительский путь совпадает с корневым путём проекта, используем корневой узел (#)
			console.log('Parent node is root, adding to root');
			const newNode = createTreeNode(fullPath);
			const nodeId = treeInstance.create_node('#', newNode, 'last', function (newNode) {
				console.log('Node added to root:', newNode);
			});
			pathToNodeMap[fullPath] = nodeId;
		} else {
			console.error('Parent directory node not found, cannot update subtree');
		}
	}
	else
		console.error(`Unknown event type: ${eventType}`)
}

function createTreeNode(fullPath) {
	const stats = fs.statSync(fullPath);
	const isDirectory = stats.isDirectory();

	return {
		text: path.basename(fullPath),
		path: fullPath,
		type: isDirectory ? 'folder' : 'file',
		icon: isDirectory ? 'bi bi-folder' : 'bi bi-file-earmark',
		children: isDirectory ? getDirectoryStructure(fullPath) : undefined
	};
}

function updateFileContent(filePath) {
	if (editor.getValue() !== fs.readFileSync(filePath, 'utf8')) {
		openFile(filePath);
	}
}

editor.commands.addCommand({
	name: 'saveFile',
	bindKey: {win: 'Ctrl-S', mac: 'Command-S'},
	exec: function (editor) {
		if (currentOpenedFile) {
			fs.writeFileSync(currentOpenedFile, editor.getValue(), 'utf8');
			console.log('File saved:', currentOpenedFile);
		}
	},
	readOnly: false
});

function updateLoadingProgress(progress) {
	console.log(`Loading progress: ${progress}%`);
	// Todo: male a progress bar in UI
}

function initializeResizer() {
	const leftPanel = document.getElementById('left-panel');
	const resizer = document.getElementById('resizer');
	const editorPanel = document.getElementById('editor-panel');
	const body = document.body;

	let startX, startWidth;

	function startResize(e) {
		startX = e.clientX;
		startWidth = parseInt(getComputedStyle(leftPanel).width, 10);
		body.classList.add('resizing');
		document.addEventListener('mousemove', resize);
		document.addEventListener('mouseup', stopResize);
		// Prevent text selection
		e.preventDefault();
	}

	function resize(e) {
		const diff = e.clientX - startX;
		const newWidth = startWidth + diff;
		leftPanel.style.width = `${newWidth}px`;
		editorPanel.style.width = `calc(100% - ${newWidth}px)`;
	}

	function stopResize() {
		body.classList.remove('resizing');
		document.removeEventListener('mousemove', resize);
		document.removeEventListener('mouseup', stopResize);
		// Update Ace editor text size
		editor.resize();
	}

	resizer.addEventListener('mousedown', startResize);
}

initializeResizer();

$('#copy-context').on('click', () => {
	const selectedNodes = treeElement.jstree('get_checked', true);
	const options = {
		removeSingle: $('#remove-single-comments').is(':checked'),
		removeMulti: $('#remove-multi-comments').is(':checked'),
		convertSpacesToTabs: $('#convert-spaces-to-tabs').is(':checked')
	};

	let context = '';
	selectedNodes.forEach(node => {
		if (node.type === 'file') {
			let content = fs.readFileSync(node.original.path, 'utf8');
			content = processContent(content, options);
			context += `File Path: ${node.original.path}\nFile Content:\n${content}\n\n`;
		}
	});
	gui.Clipboard.get().set(context, 'text');
	alert('Context copied to clipboard');
});

// Add event listeners for checkboxes
$('#remove-single-comments, #remove-multi-comments, #convert-spaces-to-tabs').on('change', () => {
	updateTokenCount();
});

$('#save-template').on('click', saveTemplate);
$('#template-select').on('change', function() {
	loadTemplate($(this).val());
});
$('#edit-template').on('click', editTemplate);
$('#delete-template').on('click', deleteTemplate);

$('#lang-select').on('change', function () {
	const selectedMode = $(this).val();
	editor.session.setMode(`ace/mode/${selectedMode}`);
});

$('#zoom-select').on('change', function () {
	const zoom = parseFloat($(this).val());
	editor.setOption("fontSize", 16 * zoom);
});

// Switch project dir
$('#select-project').on('click', () => {
	const chooser = document.createElement('input');
	chooser.type = 'file';
	chooser.nwdirectory = true;

	chooser.addEventListener('change', (event) => {
		// Закрываем текущий watcher, если он существует
		if (currentWatcher) {
			currentWatcher.close();
			currentWatcher = null;
		}

		projectPath = chooser.value;
		updateFileTree();
		watchProjectChanges();
	});

	chooser.click();
});

gui.Window.get().on('close', function() {
	if (currentWatcher) {
		currentWatcher.close();
	}
	this.close(true);
});