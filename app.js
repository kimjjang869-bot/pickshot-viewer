// PickShot Web Viewer - Client Photo Selection
// Pure client-side: Google Drive API + local manifest support

(function () {
    'use strict';

    // ─── Config ───
    const GOOGLE_API_KEY = ''; // Set your API key for public folders
    const GOOGLE_WEB_CLIENT_ID = '661638823938-0fphunk8t7s2fkih4i8u8e7a81s9eqtu.apps.googleusercontent.com';
    const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|tiff?|heic|bmp)$/i;

    let googleAccessToken = null;

    // ─── State ───
    const state = {
        sessionId: '',
        sessionName: '',
        clientName: '',
        photos: [],       // [{id, name, thumbUrl, fullUrl, selected, comment}]
        currentIndex: 0,
        zoomed: false,
        filterSelected: false,
        isDragging: false,
        dragStart: { x: 0, y: 0 },
        scrollStart: { x: 0, y: 0 },
        touchStartX: 0,
    };

    // ─── DOM Refs ───
    const $ = (sel) => document.querySelector(sel);
    const $$ = (sel) => document.querySelectorAll(sel);

    const dom = {};

    function cacheDom() {
        dom.loadingScreen = $('#loading-screen');
        dom.loadingMessage = $('#loading-message');
        dom.emptyState = $('#empty-state');
        dom.app = $('#app');
        dom.sessionName = $('#session-name');
        dom.clientName = $('#client-name');
        dom.selectionCount = $('#selection-count');
        dom.thumbnailGrid = $('#thumbnail-grid');
        dom.previewContainer = $('#preview-container');
        dom.previewImage = $('#preview-image');
        dom.previewLoading = $('#preview-loading');
        dom.photoFilename = $('#photo-filename');
        dom.photoIndex = $('#photo-index');
        dom.commentInput = $('#comment-input');
        dom.btnPrev = $('#btn-prev');
        dom.btnNext = $('#btn-next');
        dom.btnSp = $('#btn-sp');
        dom.btnZoom = $('#btn-zoom');
        dom.btnPen = $('#btn-pen');
        dom.btnFilterSelected = $('#btn-filter-selected');
        dom.btnSubmit = $('#btn-submit');
        dom.btnSelectAll = $('#btn-select-all');
        dom.btnDeselectAll = $('#btn-deselect-all');
        dom.btnLoadDemo = $('#btn-load-demo');
        dom.manifestInput = $('#manifest-input');
        dom.submitModal = $('#submit-modal');
        dom.btnModalClose = $('#btn-modal-close');
        dom.submitSession = $('#submit-session');
        dom.submitClient = $('#submit-client');
        dom.submitCount = $('#submit-count');
        dom.submitComments = $('#submit-comments');
        dom.selectedList = $('#selected-list');
        dom.btnDownloadJson = $('#btn-download-json');
        dom.toast = $('#toast');
    }

    // ─── Init ───
    function init() {
        cacheDom();
        parseUrlParams();
        bindEvents();

        if (state.sessionId) {
            loadFromGoogleDrive(state.sessionId);
        } else {
            hideLoading();
            dom.emptyState.classList.remove('hidden');
        }
    }

    function parseUrlParams() {
        const params = new URLSearchParams(window.location.search);
        state.sessionId = params.get('session') || '';
        state.sessionName = params.get('name') || '세션';
        state.clientName = params.get('client') || '클라이언트';
    }

    // ─── Loading ───
    function showLoading(msg) {
        dom.loadingScreen.classList.remove('hidden', 'fade-out');
        dom.loadingMessage.textContent = msg || '로딩 중...';
    }

    function hideLoading() {
        dom.loadingScreen.classList.add('fade-out');
        setTimeout(() => dom.loadingScreen.classList.add('hidden'), 300);
    }

    // ─── Google Drive ───
    async function loadFromGoogleDrive(folderId) {
        showLoading('Google Drive에서 사진 불러오는 중...');

        // URL에 manifest 파일 ID가 있으면 직접 다운로드
        const params = new URLSearchParams(window.location.search);
        // URL 해시에서 manifest 읽기
        const hashParams = new URLSearchParams(window.location.hash.substring(1));

        // mid= : GitHub Pages에 저장된 manifest (가장 안정적)
        const midParam = params.get('mid');
        if (midParam) {
            try {
                const manifestUrl = `./data/${midParam}.json`;
                const resp = await fetch(manifestUrl);
                if (resp.ok) {
                    const manifest = await resp.json();
                    loadFromManifest(manifest);
                    return;
                }
            } catch (e) {
                console.log('GitHub manifest 로드 실패:', e);
            }
        }

        // gz= : zlib 압축 + Base64 (fallback)
        const gzParam = params.get('gz') || hashParams.get('gz');
        if (gzParam) {
            try {
                const binary = atob(gzParam);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                // zlib/deflate 해제 (pako 없이 DecompressionStream 사용)
                const ds = new DecompressionStream('deflate');
                const writer = ds.writable.getWriter();
                writer.write(bytes);
                writer.close();
                const reader = ds.readable.getReader();
                const chunks = [];
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    chunks.push(value);
                }
                const decoded = new TextDecoder().decode(new Uint8Array(chunks.flatMap(c => [...c])));
                const manifest = JSON.parse(decoded);
                loadFromManifest(manifest);
                return;
            } catch (e) {
                console.log('gz 파라미터 해제 실패:', e);
            }
        }

        // #data= : 일반 Base64
        let dataParam = hashParams.get('data') || params.get('data');
        if (dataParam) {
            try {
                const json = atob(dataParam);
                const manifest = JSON.parse(json);
                loadFromManifest(manifest);
                return;
            } catch (e) {
                console.log('data 파라미터 파싱 실패:', e);
            }
        }

        // manifest 파일 ID가 있으면 여러 방법 시도
        const manifestId = params.get('manifest');
        if (manifestId) {
            // JSONP 방식: Google Drive 파일을 script 태그로 로드
            // manifest를 JSONP callback으로 감싸서 업로드하면 CORS 우회 가능

            // 방법 1: fetch 시도 (일부 브라우저/설정에서 작동)
            const urls = [
                `https://www.googleapis.com/drive/v3/files/${manifestId}?alt=media`,
                `https://drive.google.com/uc?id=${manifestId}&export=download`,
            ];
            for (const url of urls) {
                try {
                    const resp = await fetch(url, { redirect: 'follow', mode: 'cors' });
                    if (resp.ok) {
                        const text = await resp.text();
                        if (text.trimStart().startsWith('{')) {
                            loadFromManifest(JSON.parse(text));
                            return;
                        }
                    }
                } catch (e) { continue; }
            }

            // 방법 2: no-cors + opaque response → 안 됨
            // 방법 3: 사용자에게 manifest 파일 직접 로드 안내
            hideLoading();
            dom.emptyState.classList.remove('hidden');
            dom.emptyState.innerHTML = `
                <div style="text-align:center; padding: 20px;">
                    <h2 style="color: var(--accent-blue);">사진 로딩 중...</h2>
                    <p style="color: var(--text-secondary); margin: 12px 0;">
                        Google Drive 보안 정책으로 직접 로딩이 제한될 수 있습니다.
                    </p>
                    <p style="color: var(--text-secondary); font-size: 13px; margin: 8px 0;">
                        아래 버튼을 눌러 manifest 파일을 다운로드한 후,<br>
                        "매니페스트 파일 열기"로 로드해주세요.
                    </p>
                    <div style="margin: 16px 0; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap;">
                        <a href="https://drive.google.com/uc?id=${manifestId}&export=download"
                           download="manifest.json"
                           style="padding: 10px 20px; background: var(--accent-blue); color: white; border-radius: 8px; text-decoration: none; font-weight: 600;">
                            📥 manifest 다운로드
                        </a>
                        <label for="manifest-input"
                               style="padding: 10px 20px; background: var(--bg-surface); color: var(--text-primary); border-radius: 8px; cursor: pointer; border: 1px solid var(--border-color);">
                            📂 매니페스트 파일 열기
                        </label>
                    </div>
                    <p style="color: var(--text-muted); font-size: 11px;">
                        또는 데모 모드로 체험해보세요
                    </p>
                    <button onclick="location.href=location.pathname"
                            style="padding: 8px 16px; background: var(--bg-hover); color: var(--text-secondary); border: 1px solid var(--border-color); border-radius: 6px; cursor: pointer;">
                        데모 모드
                    </button>
                </div>
            `;
            return;
        }

        // Google Drive API (API 키 필요)
        const apiKey = GOOGLE_API_KEY;
        if (!apiKey) {
            // API 키 없이 manifest.json 직접 시도
            try {
                const resp = await fetch('manifest.json');
                if (resp.ok) {
                    const manifest = await resp.json();
                    loadFromManifest(manifest);
                    return;
                }
            } catch (e) { /* no manifest */ }

            hideLoading();
            dom.emptyState.classList.remove('hidden');
            showToast('매니페스트 파일을 로드할 수 없습니다. 링크를 확인해주세요.');
            return;
        }

        try {
            const query = `'${folderId}' in parents and trashed=false and (${
                ['image/jpeg','image/png','image/webp','image/tiff','image/heic']
                    .map(m => `mimeType='${m}'`).join(' or ')
            })`;
            const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,thumbnailLink)&pageSize=1000&orderBy=name&key=${apiKey}`;

            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`Drive API error: ${resp.status}`);
            const data = await resp.json();

            if (!data.files || data.files.length === 0) {
                hideLoading();
                dom.emptyState.classList.remove('hidden');
                showToast('폴더에 사진이 없습니다.');
                return;
            }

            state.photos = data.files.map((f, i) => ({
                id: f.id,
                name: f.name,
                thumbUrl: f.thumbnailLink ? f.thumbnailLink.replace(/=s\d+/, '=s300') : `https://drive.google.com/thumbnail?id=${f.id}&sz=w300`,
                fullUrl: `https://drive.google.com/uc?id=${f.id}`,
                selected: false,
                comment: '',
            }));

            startApp();
        } catch (err) {
            console.error('Drive load error:', err);
            hideLoading();
            dom.emptyState.classList.remove('hidden');
            showToast('Google Drive 로딩 실패: ' + err.message);
        }
    }

    // ─── Manifest ───
    function loadFromManifest(manifest) {
        // 원본 ZIP 다운로드 버튼
        if (manifest.originalZipFileId) {
            const dlBtn = document.getElementById('btn-download-original');
            if (dlBtn) {
                dlBtn.classList.remove('hidden');
                dlBtn.addEventListener('click', () => {
                    window.open(`https://drive.google.com/uc?id=${manifest.originalZipFileId}&export=download`, '_blank');
                });
            }
        }
        if (manifest.sessionName) state.sessionName = manifest.sessionName;
        if (manifest.session) state.sessionName = manifest.session;
        if (manifest.clientName) state.clientName = manifest.clientName;
        if (manifest.client) state.clientName = manifest.client;

        state.photos = (manifest.photos || []).map((p, i) => ({
            id: p.driveFileId || p.id || `photo_${i}`,
            name: p.filename || p.name || `Photo ${i + 1}`,
            thumbUrl: p.thumbUrl || (p.driveFileId ? `https://drive.google.com/thumbnail?id=${p.driveFileId}&sz=w200` : ''),
            fullUrl: p.fullUrl || (p.driveFileId ? `https://drive.google.com/thumbnail?id=${p.driveFileId}&sz=w1200` : ''),
            originalFilename: p.originalFilename || '',
            selected: p.selected || false,
            comment: '',
        }));

        startApp();
    }

    // ─── Demo Mode ───
    function loadDemoPhotos() {
        state.sessionName = '데모 세션';
        state.clientName = '데모 클라이언트';

        // Generate demo photos using picsum
        const count = 30;
        state.photos = [];
        for (let i = 0; i < count; i++) {
            const seed = 100 + i;
            state.photos.push({
                id: `demo_${i}`,
                name: `DSC_${String(1000 + i).padStart(4, '0')}.jpg`,
                thumbUrl: `https://picsum.photos/seed/${seed}/300/300`,
                fullUrl: `https://picsum.photos/seed/${seed}/1600/1200`,
                selected: false,
                comment: '',
            });
        }

        startApp();
    }

    // ─── Start App ───
    function startApp() {
        hideLoading();
        dom.emptyState.classList.add('hidden');
        dom.app.classList.remove('hidden');

        dom.sessionName.textContent = state.sessionName;
        dom.clientName.textContent = state.clientName;

        renderThumbnails();
        if (state.photos.length > 0) {
            selectPhoto(0);
        }
        updateCounts();

        // Restore from localStorage
        restoreState();
    }

    // ─── Thumbnails ───
    function renderThumbnails() {
        const grid = dom.thumbnailGrid;
        grid.innerHTML = '';

        const visiblePhotos = getVisiblePhotos();

        visiblePhotos.forEach((photo, vIdx) => {
            const realIdx = state.photos.indexOf(photo);
            const item = document.createElement('div');
            item.className = 'thumb-item';
            item.dataset.index = realIdx;
            if (realIdx === state.currentIndex) item.classList.add('active');
            if (photo.selected) item.classList.add('selected');

            const img = document.createElement('img');
            img.className = 'loading';
            img.alt = photo.name;
            img.loading = 'lazy';
            img.src = photo.thumbUrl;
            img.onload = () => img.classList.remove('loading');
            img.onerror = () => {
                img.src = 'data:image/svg+xml,' + encodeURIComponent(
                    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#333" width="100" height="100"/><text fill="#666" font-size="12" x="50" y="55" text-anchor="middle">No Image</text></svg>'
                );
            };

            const num = document.createElement('span');
            num.className = 'thumb-number';
            num.textContent = realIdx + 1;

            item.appendChild(img);
            item.appendChild(num);
            item.addEventListener('click', () => selectPhoto(realIdx));

            grid.appendChild(item);
        });
    }

    function getVisiblePhotos() {
        if (state.filterSelected) {
            return state.photos.filter(p => p.selected);
        }
        return state.photos;
    }

    function updateThumbnailStates() {
        const items = dom.thumbnailGrid.querySelectorAll('.thumb-item');
        items.forEach(item => {
            const idx = parseInt(item.dataset.index);
            const photo = state.photos[idx];
            item.classList.toggle('active', idx === state.currentIndex);
            item.classList.toggle('selected', photo && photo.selected);
        });
    }

    function scrollThumbnailIntoView(index) {
        const item = dom.thumbnailGrid.querySelector(`[data-index="${index}"]`);
        if (item) {
            item.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
        }
    }

    // ─── Photo Selection ───
    function selectPhoto(index) {
        if (index < 0 || index >= state.photos.length) return;

        // Save comment from previous photo
        saveCurrentComment();

        state.currentIndex = index;
        const photo = state.photos[index];

        // 미리보기: 썸네일 즉시 표시 → 풀이미지 백그라운드 로드
        dom.previewImage.src = photo.thumbUrl;  // 즉시 표시 (300px)
        dom.previewLoading.classList.remove('hidden');

        const img = new Image();
        img.onload = () => {
            // 현재 사진이 아직 같은 사진이면 풀이미지로 교체
            if (state.currentIndex === index) {
                dom.previewImage.src = img.src;
            }
            dom.previewLoading.classList.add('hidden');
        };
        img.onerror = () => {
            dom.previewLoading.classList.add('hidden');
        };
        img.src = photo.fullUrl;  // 백그라운드 로드 (1200px)

        // Update info
        dom.photoFilename.textContent = photo.name;
        dom.photoIndex.textContent = `${index + 1} / ${state.photos.length}`;
        dom.commentInput.value = photo.comment || '';

        // Update SP button state + 미리보기 보더
        dom.btnSp.classList.toggle('active', photo.selected);
        dom.previewImage.style.border = photo.selected ? '4px solid #30D158' : 'none';
        dom.previewImage.style.borderRadius = photo.selected ? '4px' : '0';

        // Reset zoom
        if (state.zoomed) toggleZoom();

        // Update thumbnail highlights
        updateThumbnailStates();
        scrollThumbnailIntoView(index);
        updateCounts();

        // 펜 캔버스 리드로우
        if (penActive) {
            setTimeout(resizePenCanvas, 100);
        } else if (typeof redrawPen === 'function') {
            setTimeout(redrawPen, 100);
        }

        // 앞뒤 3장 프리페치 (백그라운드 로드)
        prefetchNearby(index, 3);
    }

    // ─── 이미지 프리페치 ───
    const prefetchCache = new Set();
    function prefetchNearby(centerIndex, range) {
        for (let offset = 1; offset <= range; offset++) {
            [centerIndex + offset, centerIndex - offset].forEach(i => {
                if (i >= 0 && i < state.photos.length) {
                    const photo = state.photos[i];
                    // 풀이미지 프리페치
                    if (photo.fullUrl && !prefetchCache.has(photo.fullUrl)) {
                        prefetchCache.add(photo.fullUrl);
                        const img = new Image();
                        img.src = photo.fullUrl;
                    }
                    // 썸네일도 프리페치 (모바일 네트워크 대비)
                    if (photo.thumbUrl && !prefetchCache.has(photo.thumbUrl)) {
                        prefetchCache.add(photo.thumbUrl);
                        const img2 = new Image();
                        img2.src = photo.thumbUrl;
                    }
                }
            });
        }
    }

    function navigatePrev() {
        if (state.filterSelected) {
            const visible = getVisiblePhotos();
            const curVIdx = visible.indexOf(state.photos[state.currentIndex]);
            if (curVIdx > 0) {
                selectPhoto(state.photos.indexOf(visible[curVIdx - 1]));
            }
        } else {
            if (state.currentIndex > 0) selectPhoto(state.currentIndex - 1);
        }
    }

    function navigateNext() {
        if (state.filterSelected) {
            const visible = getVisiblePhotos();
            const curVIdx = visible.indexOf(state.photos[state.currentIndex]);
            if (curVIdx < visible.length - 1) {
                selectPhoto(state.photos.indexOf(visible[curVIdx + 1]));
            }
        } else {
            if (state.currentIndex < state.photos.length - 1) selectPhoto(state.currentIndex + 1);
        }
    }

    function navigateByRow(direction) {
        // 썸네일 그리드에서 한 행의 열 수 계산
        const grid = dom.thumbnailGrid;
        const items = grid.querySelectorAll('.thumb-item');
        if (items.length < 2) return;
        const firstRect = items[0].getBoundingClientRect();
        const secondRect = items[1].getBoundingClientRect();
        // 같은 행이면 가로 배치, 다른 행이면 세로
        let columnsPerRow = 1;
        for (let i = 1; i < items.length; i++) {
            if (items[i].getBoundingClientRect().top > firstRect.top + 5) {
                columnsPerRow = i;
                break;
            }
        }
        if (columnsPerRow < 1) columnsPerRow = 1;
        const newIndex = state.currentIndex + (direction * columnsPerRow);
        if (newIndex >= 0 && newIndex < state.photos.length) {
            selectPhoto(newIndex);
        }
    }

    // ─── SP Select ───
    function toggleSp(index) {
        if (index === undefined) index = state.currentIndex;
        const photo = state.photos[index];
        if (!photo) return;
        photo.selected = !photo.selected;

        dom.btnSp.classList.toggle('active', photo.selected);
        // 미리보기 보더 업데이트
        if (index === state.currentIndex) {
            dom.previewImage.style.border = photo.selected ? '4px solid #30D158' : 'none';
            dom.previewImage.style.borderRadius = photo.selected ? '4px' : '0';
        }
        updateThumbnailStates();
        updateCounts();
        saveState();
    }

    function selectAll() {
        state.photos.forEach(p => p.selected = true);
        updateThumbnailStates();
        updateCounts();
        dom.btnSp.classList.toggle('active', state.photos[state.currentIndex]?.selected);
        saveState();
        showToast('전체 선택됨');
    }

    function deselectAll() {
        state.photos.forEach(p => p.selected = false);
        updateThumbnailStates();
        updateCounts();
        dom.btnSp.classList.toggle('active', false);
        saveState();
        showToast('선택 해제됨');
    }

    // ─── Comments ───
    function saveCurrentComment() {
        const photo = state.photos[state.currentIndex];
        if (photo && dom.commentInput) {
            photo.comment = dom.commentInput.value.trim();
        }
    }

    // ─── Zoom ───
    function toggleZoom() {
        state.zoomed = !state.zoomed;
        dom.previewContainer.classList.toggle('zoomed', state.zoomed);
        dom.btnZoom.classList.toggle('active', state.zoomed);

        if (!state.zoomed) {
            dom.previewContainer.scrollTop = 0;
            dom.previewContainer.scrollLeft = 0;
        }
    }

    // ─── Filter ───
    function toggleFilter() {
        state.filterSelected = !state.filterSelected;
        dom.btnFilterSelected.classList.toggle('active', state.filterSelected);
        renderThumbnails();
        showToast(state.filterSelected ? '선택된 사진만 표시' : '전체 사진 표시');
    }

    // ─── Counts ───
    function updateCounts() {
        const selected = state.photos.filter(p => p.selected).length;
        const total = state.photos.length;
        dom.selectionCount.textContent = `선택: ${selected} / 전체: ${total}`;
    }

    // ─── Submit ───
    function openSubmitModal() {
        saveCurrentComment();

        const selected = state.photos.filter(p => p.selected);
        const withComments = selected.filter(p => p.comment);

        dom.submitSession.textContent = state.sessionName;
        dom.submitClient.textContent = state.clientName;
        dom.submitCount.textContent = `${selected.length}장`;
        dom.submitComments.textContent = `${withComments.length}장`;

        // Render selected list
        dom.selectedList.innerHTML = '';
        selected.forEach(photo => {
            const item = document.createElement('div');
            item.className = 'selected-item';

            const thumb = document.createElement('img');
            thumb.className = 'selected-item-thumb';
            thumb.src = photo.thumbUrl;
            thumb.alt = photo.name;

            const name = document.createElement('span');
            name.className = 'selected-item-name';
            name.textContent = photo.name;

            item.appendChild(thumb);
            item.appendChild(name);

            if (photo.comment) {
                const comment = document.createElement('span');
                comment.className = 'selected-item-comment';
                comment.textContent = photo.comment;
                item.appendChild(comment);
            }

            dom.selectedList.appendChild(item);
        });

        dom.submitModal.classList.remove('hidden');
    }

    function closeSubmitModal() {
        dom.submitModal.classList.add('hidden');
    }

    // ─── Generate Pickshot JSON (shared between download and upload) ───
    function generatePickshotJSON() {
        saveCurrentComment();

        const selected = state.photos.filter(p => p.selected);
        return {
            version: '1.0',
            app: 'PickShot Viewer',
            exportedAt: new Date().toISOString(),
            session: {
                id: state.sessionId,
                name: state.sessionName,
                client: state.clientName,
            },
            totalPhotos: state.photos.length,
            selectedCount: selected.length,
            photos: state.photos.map(p => ({
                filename: p.name,
                originalFilename: p.originalFilename || p.name,
                driveFileId: p.id,
                selected: p.selected,
                comment: p.comment || '',
                annotations: (penPaths[state.photos.indexOf(p)] || []).map(path => ({
                    type: 'freehand',
                    color: path.color,
                    points: path.points
                })),
            })),
        };
    }

    function downloadPickshot() {
        const result = generatePickshotJSON();

        const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${state.sessionName}_${state.clientName}_selection.pickshot`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('셀렉 파일 다운로드 완료');
        closeSubmitModal();
    }

    // ─── Google Drive OAuth Upload ───
    function initGoogleAuth() {
        // Google Identity Services is loaded async via script tag.
        // We only initialize the token client when the user clicks "Drive에 전송".
        // Nothing to do here proactively — the library loads in the background.
    }

    async function uploadToDrive() {
        saveCurrentComment();
        const selected = state.photos.filter(p => p.selected);
        if (selected.length === 0) {
            showToast('선택된 사진이 없습니다');
            return;
        }

        // Case 1: Already have an access token — upload directly
        if (googleAccessToken) {
            await doUploadToDrive();
            return;
        }

        // Case 2: Client ID is set — trigger OAuth popup
        if (GOOGLE_WEB_CLIENT_ID) {
            if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
                showToast('Google 인증 라이브러리를 로딩 중입니다. 잠시 후 다시 시도해주세요.');
                return;
            }

            const tokenClient = google.accounts.oauth2.initTokenClient({
                client_id: GOOGLE_WEB_CLIENT_ID,
                scope: 'https://www.googleapis.com/auth/drive.file',
                callback: async (tokenResponse) => {
                    if (tokenResponse && tokenResponse.access_token) {
                        googleAccessToken = tokenResponse.access_token;
                        await doUploadToDrive();
                    } else {
                        showToast('Google 인증이 취소되었습니다.');
                    }
                },
                error_callback: (err) => {
                    console.error('Google OAuth error:', err);
                    showToast('Google 인증 실패. 파일을 다운로드합니다.');
                    downloadPickshot();
                },
            });

            tokenClient.requestAccessToken();
            return;
        }

        // Case 3: No client ID — fallback to download
        downloadPickshot();
        showToast('파일을 다운로드했습니다. Google Drive 폴더에 직접 업로드해주세요.');
    }

    async function doUploadToDrive() {
        const result = generatePickshotJSON();
        const jsonStr = JSON.stringify(result, null, 2);
        const filename = `${state.clientName || 'client'}_selection.pickshot`;

        const folderId = state.sessionId;
        const boundary = 'pickshot_boundary_' + Date.now();
        const metadata = folderId
            ? JSON.stringify({ name: filename, parents: [folderId] })
            : JSON.stringify({ name: filename });

        let body = '';
        body += `--${boundary}\r\n`;
        body += 'Content-Type: application/json; charset=UTF-8\r\n\r\n';
        body += metadata + '\r\n';
        body += `--${boundary}\r\n`;
        body += 'Content-Type: application/json\r\n\r\n';
        body += jsonStr + '\r\n';
        body += `--${boundary}--`;

        const btn = document.getElementById('btn-upload-drive');
        const originalText = btn.innerHTML;
        btn.innerHTML = '업로드 중...';
        btn.disabled = true;

        try {
            const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${googleAccessToken}`,
                    'Content-Type': `multipart/related; boundary=${boundary}`,
                },
                body: body,
            });

            if (resp.ok) {
                showToast('셀렉 결과가 Google Drive에 저장되었습니다!');
                btn.innerHTML = '전송 완료';
                setTimeout(closeSubmitModal, 1500);
            } else {
                const errData = await resp.json().catch(() => ({}));
                console.error('Drive upload failed:', resp.status, errData);
                // Token might be expired — clear it
                if (resp.status === 401) {
                    googleAccessToken = null;
                    showToast('인증이 만료되었습니다. 다시 시도해주세요.');
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                } else {
                    showToast('Drive 업로드 실패. 파일을 다운로드합니다.');
                    downloadPickshot();
                    btn.innerHTML = originalText;
                    btn.disabled = false;
                }
            }
        } catch (e) {
            console.error('Drive upload error:', e);
            downloadPickshot();
            showToast('파일을 다운로드했습니다. Google Drive 폴더에 직접 업로드해주세요.');
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }

    function sharePickshot() {
        // .pickshot 파일 생성 후 Web Share API로 공유 (모바일)
        saveCurrentComment();
        const selected = state.photos.filter(p => p.selected);
        const result = {
            version: '1.0',
            app: 'PickShot Viewer',
            exportedAt: new Date().toISOString(),
            session: { id: state.sessionId, name: state.sessionName, client: state.clientName },
            totalPhotos: state.photos.length,
            selectedCount: selected.length,
            photos: state.photos.map(p => ({
                filename: p.name,
                originalFilename: p.originalFilename || p.name,
                selected: p.selected,
                comment: p.comment || '',
            })),
        };

        const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
        const file = new File([blob], `${state.sessionName}_selection.pickshot`, { type: 'application/json' });

        if (navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
            // 모바일: 네이티브 공유 (카톡, 메일 등)
            navigator.share({
                title: `${state.sessionName} 셀렉 결과`,
                text: `${selected.length}장 셀렉 완료`,
                files: [file]
            }).then(() => {
                showToast('공유 완료');
                closeSubmitModal();
            }).catch(() => {
                // 공유 취소 — 다운로드로 폴백
                downloadPickshot();
            });
        } else {
            // PC: 다운로드 후 안내
            downloadPickshot();
            showToast('파일을 다운로드했습니다. 카톡이나 메일로 전송해주세요.');
        }
    }

    // ─── State Persistence ───
    function getStorageKey() {
        return `pickshot_${state.sessionId || 'local'}_${state.clientName}`;
    }

    function saveState() {
        try {
            const data = {
                selections: {},
                comments: {},
            };
            state.photos.forEach(p => {
                if (p.selected) data.selections[p.id] = true;
                if (p.comment) data.comments[p.id] = p.comment;
            });
            localStorage.setItem(getStorageKey(), JSON.stringify(data));
        } catch (e) { /* quota exceeded, ignore */ }
    }

    function restoreState() {
        try {
            const raw = localStorage.getItem(getStorageKey());
            if (!raw) return;
            const data = JSON.parse(raw);
            state.photos.forEach(p => {
                if (data.selections && data.selections[p.id]) p.selected = true;
                if (data.comments && data.comments[p.id]) p.comment = data.comments[p.id];
            });
            updateThumbnailStates();
            updateCounts();
            // Refresh current photo
            if (state.photos[state.currentIndex]) {
                dom.commentInput.value = state.photos[state.currentIndex].comment || '';
                dom.btnSp.classList.toggle('active', state.photos[state.currentIndex].selected);
            }
        } catch (e) { /* ignore */ }
    }

    // ─── Toast ───
    function showToast(msg) {
        dom.toast.textContent = msg;
        dom.toast.classList.remove('hidden', 'fade-out');
        clearTimeout(showToast._timer);
        showToast._timer = setTimeout(() => {
            dom.toast.classList.add('fade-out');
            setTimeout(() => dom.toast.classList.add('hidden'), 300);
        }, 2000);
    }

    // ─── Drag to pan (zoomed) ───
    function onPreviewMouseDown(e) {
        if (!state.zoomed) return;
        state.isDragging = true;
        state.dragStart = { x: e.clientX, y: e.clientY };
        state.scrollStart = {
            x: dom.previewContainer.scrollLeft,
            y: dom.previewContainer.scrollTop,
        };
        dom.previewImage.classList.add('grabbing');
        e.preventDefault();
    }

    function onPreviewMouseMove(e) {
        if (!state.isDragging) return;
        const dx = e.clientX - state.dragStart.x;
        const dy = e.clientY - state.dragStart.y;
        dom.previewContainer.scrollLeft = state.scrollStart.x - dx;
        dom.previewContainer.scrollTop = state.scrollStart.y - dy;
    }

    function onPreviewMouseUp() {
        state.isDragging = false;
        dom.previewImage.classList.remove('grabbing');
    }

    // ─── Touch swipe ───
    function onTouchStart(e) {
        if (state.zoomed) return;
        state.touchStartX = e.touches[0].clientX;
    }

    function onTouchEnd(e) {
        if (state.zoomed) return;
        const dx = e.changedTouches[0].clientX - state.touchStartX;
        if (Math.abs(dx) > 50) {
            if (dx > 0) navigatePrev();
            else navigateNext();
        }
    }

    // ─── Events ───
    function bindEvents() {
        // Navigation
        dom.btnPrev.addEventListener('click', navigatePrev);
        dom.btnNext.addEventListener('click', navigateNext);

        // SP Select
        dom.btnSp.addEventListener('click', () => { toggleSp(); saveState(); });

        // 미리보기 클릭: 싱글클릭=확대, 더블클릭=SP 셀렉
        dom.btnZoom.addEventListener('click', toggleZoom);
        let clickTimer = null;
        dom.previewContainer.addEventListener('click', (e) => {
            if (e.target === dom.previewImage || e.target === dom.previewContainer) {
                if (state.isDragging) return;
                if (clickTimer) {
                    // 더블클릭 — SP 토글
                    clearTimeout(clickTimer);
                    clickTimer = null;
                    toggleSp();
                    saveState();
                } else {
                    // 싱글클릭 대기 (200ms)
                    clickTimer = setTimeout(() => {
                        clickTimer = null;
                        toggleZoom();
                    }, 250);
                }
            }
        });

        // Pan when zoomed
        dom.previewContainer.addEventListener('mousedown', onPreviewMouseDown);
        window.addEventListener('mousemove', onPreviewMouseMove);
        window.addEventListener('mouseup', onPreviewMouseUp);

        // Touch swipe
        dom.previewContainer.addEventListener('touchstart', onTouchStart, { passive: true });
        dom.previewContainer.addEventListener('touchend', onTouchEnd, { passive: true });

        // Filter
        dom.btnFilterSelected.addEventListener('click', toggleFilter);

        // Select all / deselect
        dom.btnSelectAll.addEventListener('click', selectAll);
        dom.btnDeselectAll.addEventListener('click', deselectAll);

        // Submit
        dom.btnSubmit.addEventListener('click', openSubmitModal);
        dom.btnModalClose.addEventListener('click', closeSubmitModal);
        dom.submitModal.querySelector('.modal-backdrop').addEventListener('click', closeSubmitModal);
        dom.btnDownloadJson.addEventListener('click', downloadPickshot);
        document.getElementById('btn-upload-drive')?.addEventListener('click', uploadToDrive);
        document.getElementById('btn-share-pickshot')?.addEventListener('click', sharePickshot);

        // Comment auto-save
        dom.commentInput.addEventListener('input', () => {
            saveCurrentComment();
            saveState();
        });

        // Pen placeholder
        dom.btnPen.addEventListener('click', () => {
            showToast('펜 도구는 다음 업데이트에서 지원됩니다.');
        });

        // Empty state
        dom.btnLoadDemo.addEventListener('click', () => {
            dom.emptyState.classList.add('hidden');
            showLoading('데모 사진 생성 중...');
            setTimeout(loadDemoPhotos, 300);
        });

        dom.manifestInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            dom.emptyState.classList.add('hidden');
            showLoading('매니페스트 로딩 중...');
            const reader = new FileReader();
            reader.onload = () => {
                try {
                    const manifest = JSON.parse(reader.result);
                    loadFromManifest(manifest);
                } catch (err) {
                    hideLoading();
                    dom.emptyState.classList.remove('hidden');
                    showToast('잘못된 매니페스트 파일입니다.');
                }
            };
            reader.readAsText(file);
        });

        // Keyboard
        document.addEventListener('keydown', (e) => {
            // Don't capture if typing in comment
            if (e.target === dom.commentInput) {
                if (e.key === 'Escape') dom.commentInput.blur();
                return;
            }

            switch (e.key) {
                case 'ArrowLeft':
                    e.preventDefault();
                    navigatePrev();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    navigateNext();
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    navigateByRow(1);  // 한 행 아래
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    navigateByRow(-1);  // 한 행 위
                    break;
                case ' ':
                    e.preventDefault();
                    toggleSp();
                    saveState();
                    break;
                case 'Escape':
                    if (!dom.submitModal.classList.contains('hidden')) {
                        closeSubmitModal();
                    } else if (state.zoomed) {
                        toggleZoom();
                    }
                    break;
                case 'f':
                case 'F':
                    toggleFilter();
                    break;
                case 'z':
                case 'Z':
                    toggleZoom();
                    break;
            }
        });

        // Prevent accidental back navigation
        window.addEventListener('beforeunload', (e) => {
            const hasSelections = state.photos.some(p => p.selected);
            if (hasSelections) {
                e.preventDefault();
                e.returnValue = '';
            }
        });
    }

    // ─── Pen Tool ───
    let penActive = false;
    let penColor = '#FF3B30';
    let penDrawing = false;
    let penPaths = {};  // photoIndex → [[{x,y},...], ...]
    let currentPenPath = [];

    function togglePen() {
        penActive = !penActive;
        const canvas = document.getElementById('pen-canvas');
        const toolbar = document.getElementById('pen-toolbar');
        const btn = dom.btnPen || document.getElementById('btn-pen');

        if (penActive) {
            canvas.classList.remove('hidden');
            toolbar.classList.remove('hidden');
            btn.classList.add('pen-active');
            resizePenCanvas();
        } else {
            canvas.classList.add('hidden');
            toolbar.classList.add('hidden');
            btn.classList.remove('pen-active');
        }
    }

    function resizePenCanvas() {
        const canvas = document.getElementById('pen-canvas');
        const container = document.getElementById('preview-container');
        canvas.width = container.offsetWidth;
        canvas.height = container.offsetHeight;
        redrawPen();
    }

    function redrawPen() {
        const canvas = document.getElementById('pen-canvas');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const paths = penPaths[state.currentIndex] || [];
        for (const path of paths) {
            if (path.points.length < 2) continue;
            ctx.beginPath();
            ctx.strokeStyle = path.color;
            ctx.lineWidth = 3;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.moveTo(path.points[0].x * canvas.width, path.points[0].y * canvas.height);
            for (let i = 1; i < path.points.length; i++) {
                ctx.lineTo(path.points[i].x * canvas.width, path.points[i].y * canvas.height);
            }
            ctx.stroke();
        }
    }

    function initPenEvents() {
        const canvas = document.getElementById('pen-canvas');

        canvas.addEventListener('mousedown', (e) => {
            if (!penActive) return;
            penDrawing = true;
            currentPenPath = [];
            const rect = canvas.getBoundingClientRect();
            currentPenPath.push({ x: (e.clientX - rect.left) / canvas.width, y: (e.clientY - rect.top) / canvas.height });
        });

        canvas.addEventListener('mousemove', (e) => {
            if (!penDrawing) return;
            const rect = canvas.getBoundingClientRect();
            const point = { x: (e.clientX - rect.left) / canvas.width, y: (e.clientY - rect.top) / canvas.height };
            currentPenPath.push(point);

            // 실시간 그리기
            const ctx = canvas.getContext('2d');
            if (currentPenPath.length > 1) {
                const prev = currentPenPath[currentPenPath.length - 2];
                ctx.beginPath();
                ctx.strokeStyle = penColor;
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';
                ctx.moveTo(prev.x * canvas.width, prev.y * canvas.height);
                ctx.lineTo(point.x * canvas.width, point.y * canvas.height);
                ctx.stroke();
            }
        });

        canvas.addEventListener('mouseup', () => {
            if (!penDrawing) return;
            penDrawing = false;
            if (currentPenPath.length > 1) {
                if (!penPaths[state.currentIndex]) penPaths[state.currentIndex] = [];
                penPaths[state.currentIndex].push({ color: penColor, points: currentPenPath });
                // 코멘트에 "[펜 마크 있음]" 자동 추가
                const photo = state.photos[state.currentIndex];
                if (photo && !photo.comment.includes('[펜 마크')) {
                    photo.comment = (photo.comment ? photo.comment + '\n' : '') + '[펜 마크 있음]';
                    if (dom.commentInput) dom.commentInput.value = photo.comment;
                }
                saveState();
            }
        });

        // 터치 지원
        canvas.addEventListener('touchstart', (e) => {
            if (!penActive) return;
            e.preventDefault();
            const touch = e.touches[0];
            const rect = canvas.getBoundingClientRect();
            penDrawing = true;
            currentPenPath = [{ x: (touch.clientX - rect.left) / canvas.width, y: (touch.clientY - rect.top) / canvas.height }];
        }, { passive: false });

        canvas.addEventListener('touchmove', (e) => {
            if (!penDrawing) return;
            e.preventDefault();
            const touch = e.touches[0];
            const rect = canvas.getBoundingClientRect();
            const point = { x: (touch.clientX - rect.left) / canvas.width, y: (touch.clientY - rect.top) / canvas.height };
            currentPenPath.push(point);
            const ctx = canvas.getContext('2d');
            if (currentPenPath.length > 1) {
                const prev = currentPenPath[currentPenPath.length - 2];
                ctx.beginPath();
                ctx.strokeStyle = penColor;
                ctx.lineWidth = 3;
                ctx.lineCap = 'round';
                ctx.moveTo(prev.x * canvas.width, prev.y * canvas.height);
                ctx.lineTo(point.x * canvas.width, point.y * canvas.height);
                ctx.stroke();
            }
        }, { passive: false });

        canvas.addEventListener('touchend', () => {
            if (!penDrawing) return;
            penDrawing = false;
            if (currentPenPath.length > 1) {
                if (!penPaths[state.currentIndex]) penPaths[state.currentIndex] = [];
                penPaths[state.currentIndex].push({ color: penColor, points: currentPenPath });
                saveState();
            }
        });

        // 색상 선택
        document.querySelectorAll('.pen-color').forEach(el => {
            el.addEventListener('click', () => {
                document.querySelectorAll('.pen-color').forEach(c => c.classList.remove('active'));
                el.classList.add('active');
                penColor = el.dataset.color;
            });
        });

        // 되돌리기
        document.getElementById('pen-undo')?.addEventListener('click', () => {
            const paths = penPaths[state.currentIndex];
            if (paths && paths.length > 0) {
                paths.pop();
                redrawPen();
                saveState();
            }
        });

        // 전체 지우기
        document.getElementById('pen-clear')?.addEventListener('click', () => {
            penPaths[state.currentIndex] = [];
            redrawPen();
            saveState();
        });

        // 펜 버튼 이벤트
        document.getElementById('btn-pen')?.addEventListener('click', togglePen);

        // 리사이즈 시 캔버스 재조정
        window.addEventListener('resize', () => {
            if (penActive) resizePenCanvas();
        });
    }

    // selectPhoto에서 펜 캔버스 리드로우
    const origSelectPhoto = selectPhoto;
    // 이미 selectPhoto가 호출되면 펜 데이터 리드로우
    const origUpdate = updateThumbnailStates;

    // ─── 모바일 스와이프 + 터치 ───
    // initMobileTouch 제거 — onTouchStart/onTouchEnd에서 이미 처리
    function initMobileTouch() { /* 중복 방지: 기존 터치 핸들러 사용 */ }

    // ─── Boot ───
    document.addEventListener('DOMContentLoaded', () => {
        init();
        initGoogleAuth();
        setTimeout(initPenEvents, 500);
        setTimeout(initMobileTouch, 500);
    });
})();
