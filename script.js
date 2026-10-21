// script.js - 商品保质期管理系统 v3.1.0
// 新增：最近删除功能、商品分类、PC端删除按钮、分页功能

const API_BASE_URL = window.location.origin;
let isRenderingExpiringTable = false;

const STORAGE_KEYS = {
    REMEMBER_ME: 'product_expiry_remember_me',
    SAVED_USERNAME: 'product_expiry_username',
    SAVED_PASSWORD: 'product_expiry_password'
};

// 删除操作节流变量
let lastDeleteTime = 0;
const DELETE_THROTTLE_MS = 2000;

// 分页状态
let allRecordsCurrentPage = 1;
let allRecordsTotalPages = 1;
let allRecordsData = [];
let databaseCurrentPage = 1;
let databaseTotalPages = 1;
let databaseData = [];
let clearanceCurrentPage = 1;
let clearanceTotalPages = 1;
let clearanceAllData = [];

// 忽略列表
let clearanceIgnoreList = JSON.parse(localStorage.getItem('clearanceIgnoreList') || '[]');

// 待出清表列表
let recentClearanceList = JSON.parse(localStorage.getItem('recentClearanceList') || '[]');
let imageCache = new Map();

// 分类筛选
let currentExpiringCategory = 'all';

// 最近删除数据
let deletedItems = [];

// 优化：提取重复的日期格式化逻辑
const BJ_DATE_UTILS = {
    createBJDate: function(dateStr) {
        if (!dateStr) return null;
        const [year, month, day] = dateStr.split('-').map(Number);
        return new Date(Date.UTC(year, month - 1, day));
    },

    getBJToday: function() {
        const now = new Date();
        const bjTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
        const year = bjTime.getUTCFullYear();
        const month = bjTime.getUTCMonth();
        const day = bjTime.getUTCDate();
        return new Date(Date.UTC(year, month, day));
    },

    formatBJDate: function(date) {
        if (!date) return '';
        const year = date.getUTCFullYear();
        const month = String(date.getUTCMonth() + 1).padStart(2, '0');
        const day = String(date.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
};

// 向后兼容的包装函数
function createBJDate(dateStr) {
    return BJ_DATE_UTILS.createBJDate(dateStr);
}

function getBJToday() {
    return BJ_DATE_UTILS.getBJToday();
}

// 计算建议出清天数 - 优化：使用配置对象
const CLEARANCE_DAYS_CONFIG = [
    { threshold: 60, days: 15 },
    { threshold: 30, days: 10 },
    { threshold: 15, days: 7 },
    { threshold: 8, days: 4 },
    { threshold: 0, days: 2 }
];

function calculateClearanceDays(shelfLife) {
    const config = CLEARANCE_DAYS_CONFIG.find(c => shelfLife > c.threshold);
    return config ? config.days : 2;
}



// 更新页面底部刷新时间
function updateRefreshTime() {
    const now = new Date();
    const timeString = now.toLocaleString('zh-CN', { 
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    const refreshElement = document.getElementById('lastRefreshTime');
    if (refreshElement) {
        refreshElement.textContent = timeString;
    }
}

window.formatDateLocal = function(date) {
    if (!date) return '-';
    if (!(date instanceof Date)) date = new Date(date);
    if (isNaN(date.getTime())) return '-';
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
};

window.calculateRemainingDaysLocal = function(productionDate, shelfLife) {
    try {
        const prodDate = createBJDate(productionDate);
        if (!prodDate) return 0;
        const expiryDate = new Date(prodDate);
        expiryDate.setUTCDate(prodDate.getUTCDate() + shelfLife);
        const today = getBJToday();
        const diffTime = expiryDate.getTime() - today.getTime();
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    } catch(e) {
        console.error('日期计算错误:', e);
        return 0;
    }
};

// 优化：HTML转义函数
function escapeHtml(str) {
    if (!str) return '';
    const htmlEscapes = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    return str.replace(/[&<>"']/g, char => htmlEscapes[char]);
}

// 优化：统一的错误处理函数
function handleError(error, context = '') {
    const errorMessage = error?.message || String(error);
    console.error(`错误 [${context}]:`, errorMessage, error);
    
    // 根据错误类型返回用户友好的消息
    if (errorMessage.includes('网络') || errorMessage.includes('fetch')) {
        return '网络连接失败，请检查网络设置';
    } else if (errorMessage.includes('授权') || errorMessage.includes('认证')) {
        return '授权失败，请重新登录';
    } else if (errorMessage.includes('服务器') || errorMessage.includes('500')) {
        return '服务器错误，请稍后重试';
    }
    
    return errorMessage;
}

// 优化：API请求封装
async function apiRequest(endpoint, method = 'GET', data = null) {
    try {
        const options = {
            method,
            headers: {
                'Content-Type': 'application/json'
            }
        };
        
        if (data && method !== 'GET') {
            options.body = JSON.stringify(data);
        }
        
        const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: response.statusText }));
            throw new Error(errorData.error || `HTTP ${response.status}`);
        }
        
        return await response.json();
    } catch (error) {
        throw handleError(error, `API请求: ${method} ${endpoint}`);
    }
}

// 最近删除管理
const DELETED_ITEMS_KEY = 'product_expiry_deleted_items';

function loadDeletedItems() {
    try {
        const stored = localStorage.getItem(DELETED_ITEMS_KEY);
        if (stored) {
            deletedItems = JSON.parse(stored);
            // 清理超过3天的记录
            const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
            const originalLength = deletedItems.length;
            deletedItems = deletedItems.filter(item => item.deletedAt > threeDaysAgo);
            if (deletedItems.length !== originalLength) {
                saveDeletedItems();
            }
        }
    } catch(e) {
        deletedItems = [];
    }
    return deletedItems;
}

function saveDeletedItems() {
    localStorage.setItem(DELETED_ITEMS_KEY, JSON.stringify(deletedItems));
}

function addToDeletedItems(item) {
    const deletedItem = {
        ...item,
        deletedAt: Date.now(),
        deletedAtDate: new Date().toISOString()
    };
    deletedItems.unshift(deletedItem); // 最新删除的放前面
    // 只保留最近50条记录
    if (deletedItems.length > 50) {
        deletedItems = deletedItems.slice(0, 50);
    }
    saveDeletedItems();
    renderDeletedList();
}

function removeFromDeletedItems(index) {
    deletedItems.splice(index, 1);
    saveDeletedItems();
    renderDeletedList();
}

function clearAllDeletedItems() {
    if (confirm('确定要清空所有删除记录吗？此操作不可恢复！')) {
        deletedItems = [];
        saveDeletedItems();
        renderDeletedList();
        showQuickToast('已清空所有删除记录', 'success');
    }
}

// 优化：使用映射表替代switch语句
const CATEGORY_CLASS_MAP = {
    '牛奶类': 'category-milk',
    '面包类': 'category-bread',
    '其他类': 'category-other'
};

function getCategoryClass(category) {
    return CATEGORY_CLASS_MAP[category] || 'category-other';
}

async function restoreDeletedItem(item, index) {
    try {
        const record = {
            sku: item.sku,
            name: item.name,
            production_date: item.production_date,
            shelf_life: item.shelf_life,
            reminder_days: item.reminder_days,
            location: item.location,
            category: item.category || '其他类'
        };
        await apiRequest('/api/records', 'POST', record);
        removeFromDeletedItems(index);
        showQuickToast(`已恢复: ${item.name}`, 'success');
        dataCache.clear();
        await renderExpiringTable(true);
        await renderAllTable(true);
        await updateExpiryCount();
    } catch (error) {
        showAlert(`恢复失败: ${error.message}`, 'danger');
    }
}

async function renderDeletedList() {
    const container = document.getElementById('deletedListContainer');
    if (!container) return;
    
    loadDeletedItems();
    
    if (deletedItems.length === 0) {
        container.innerHTML = `
            <div class="text-center py-5 text-muted">
                <i class="bi bi-inbox" style="font-size: 2rem;"></i>
                <p class="mt-2">暂无删除记录</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = '';
    for (let i = 0; i < deletedItems.length; i++) {
        const item = deletedItems[i];
        const deletedDate = new Date(item.deletedAt);
        const daysAgo = Math.floor((Date.now() - item.deletedAt) / (24 * 60 * 60 * 1000));
        const timeAgo = daysAgo === 0 ? '今天' : `${daysAgo}天前`;
        
        const div = document.createElement('div');
        div.className = 'deleted-item-card';
        div.innerHTML = `
            <div class="d-flex justify-content-between align-items-start">
                <div class="flex-grow-1">
                    <div class="deleted-item-name">${escapeHtml(item.name)}</div>
                    <div class="deleted-item-info">
                        SKU: ${escapeHtml(item.sku)} | 生产日期: ${item.production_date} | 
                        库位: ${escapeHtml(item.location || '默认位置')} | 分类: ${escapeHtml(item.category || '其他类')}
                    </div>
                    <div class="deleted-item-info text-muted">
                        <i class="bi bi-clock"></i> 删除时间: ${deletedDate.toLocaleString()} (${timeAgo})
                        <span class="text-warning ms-2">${3 - daysAgo}天后自动清除</span>
                    </div>
                </div>
                <div class="d-flex flex-column gap-2 ms-2">
                	                    <button class="btn btn-success btn-sm restore-deleted-btn" data-index="${i}">
                	                        <div><i class="bi bi-arrow-repeat"></i></div>
                	                        <div>恢复</div>
                	                    </button>
                	                    <button class="btn btn-danger btn-sm delete-deleted-btn" data-index="${i}">
                	                        <div><i class="bi bi-trash"></i></div>
                	                        <div>彻底</div>
                	                        <div>删除</div>
                	                    </button>
                	                </div>
            </div>
        `;
        container.appendChild(div);
    }
    
    // 绑定恢复和删除按钮事件
    document.querySelectorAll('.restore-deleted-btn').forEach(btn => {
        btn.removeEventListener('click', handleRestoreClick);
        btn.addEventListener('click', handleRestoreClick);
    });
    document.querySelectorAll('.delete-deleted-btn').forEach(btn => {
        btn.removeEventListener('click', handleDeleteDeletedClick);
        btn.addEventListener('click', handleDeleteDeletedClick);
    });
}

function handleRestoreClick(e) {
    const index = parseInt(e.currentTarget.getAttribute('data-index'));
    const item = deletedItems[index];
    if (item) {
        restoreDeletedItem(item, index);
    }
}

function handleDeleteDeletedClick(e) {
    const index = parseInt(e.currentTarget.getAttribute('data-index'));
    if (confirm('确定要彻底删除这条记录吗？')) {
        removeFromDeletedItems(index);
        showQuickToast('已彻底删除', 'success');
    }
}

// 表格内显示加载状态
function showTableLoading(tableId, show = true, message = '加载中...') {
    const tableBody = document.getElementById(tableId);
    if (!tableBody) return;
    
    if (show) {
        tableBody.setAttribute('data-original-content', tableBody.innerHTML);
        tableBody.innerHTML = `
            <tr class="table-loading-row">
                <td colspan="10" class="text-center py-5">
                    <div class="spinner-border text-primary" role="status" style="width: 2rem; height: 2rem;">
                        <span class="visually-hidden">加载中...</span>
                    </div>
                    <div class="mt-2 text-muted" style="font-size: 13px;">${message}</div>
                 </td>
             </tr>
        `;
    } else {
        const originalContent = tableBody.getAttribute('data-original-content');
        if (originalContent) {
            tableBody.innerHTML = originalContent;
            tableBody.removeAttribute('data-original-content');
        }
    }
}

function showCardsLoading(containerId, show = true, message = '加载中...') {
    const container = document.getElementById(containerId);
    if (!container) return;
    
    if (show) {
        container.setAttribute('data-original-content', container.innerHTML);
        container.innerHTML = `
            <div class="text-center py-5">
                <div class="spinner-border text-primary" role="status" style="width: 2rem; height: 2rem;">
                    <span class="visually-hidden">加载中...</span>
                </div>
                <div class="mt-2 text-muted">${message}</div>
            </div>
        `;
    } else {
        const originalContent = container.getAttribute('data-original-content');
        if (originalContent) {
            container.innerHTML = originalContent;
            container.removeAttribute('data-original-content');
        }
    }
}

// 缓存管理器
class DataCache {
    constructor() {
        this.products = null;
        this.records = null;
        this.expiring = null;
        this.clearance = null;
        this.lastFetch = { products: 0, records: 0, expiring: 0, clearance: 0 };
        this.cacheDuration = 15 * 60 * 1000;
    }

    isValid(cacheKey) {
        const lastFetch = this.lastFetch[cacheKey];
        if (!lastFetch) return false;
        return (Date.now() - lastFetch) < this.cacheDuration;
    }

    async getProducts(forceRefresh = false) {
        if (!forceRefresh && this.isValid('products') && this.products) {
            return this.products;
        }
        this.products = await apiRequest('/api/products');
        this.products.sort((a, b) => a.sku.localeCompare(b.sku));
        this.lastFetch.products = Date.now();
        return this.products;
    }

    async getRecords(forceRefresh = false) {
        if (!forceRefresh && this.isValid('records') && this.records) {
            return this.records;
        }
        this.records = await apiRequest('/api/records');
        this.records.forEach(r => {
            r.remaining_days = calculateRemainingDaysLocal(r.production_date, r.shelf_life);
        });
        this.records.sort((a, b) => a.remaining_days - b.remaining_days);
        this.lastFetch.records = Date.now();
        return this.records;
    }

    async getExpiring(forceRefresh = false) {
        if (!forceRefresh && this.isValid('expiring') && this.expiring) {
            return this.expiring;
        }
        const records = await this.getRecords(forceRefresh);
        this.expiring = records.filter(r => {
            const remaining = r.remaining_days;
            const reminder = r.reminder_days || 0;
            return remaining <= reminder;
        });
        this.lastFetch.expiring = Date.now();
        return this.expiring;
    }

    // 新增：获取建议出清商品
    async getClearance(forceRefresh = false) {
        if (!forceRefresh && this.isValid('clearance') && this.clearance) {
            return this.clearance;
        }
        // 重新从localStorage加载忽略列表，确保获取最新状态
        const currentIgnoreList = JSON.parse(localStorage.getItem('clearanceIgnoreList') || '[]');
        const records = await this.getRecords(forceRefresh);
        console.log('出清计算调试 - 总记录数:', records.length);
        console.log('当前忽略列表:', currentIgnoreList);
        
        this.clearance = records.filter(r => {
            const remaining = r.remaining_days;
            const clearanceDays = calculateClearanceDays(r.shelf_life);
            // 建议出清逻辑：剩余天数 <= 建议出清天数 OR 剩余天数 <= 临期提醒天数（已临期的商品也应该出现在建议出清页）
            const shouldShow = (remaining <= clearanceDays && clearanceDays > 0) || remaining <= (r.reminder_days || 0);
            
            // 过滤掉被忽略的商品
            const ignoreKey = `${r.sku}_${r.production_date}`;
            const isIgnored = currentIgnoreList.includes(ignoreKey);
            
            // 调试：检查保质期15天还剩7天的记录
            if (r.shelf_life === 15 && remaining === 7) {
                console.log('保质期15天还剩7天记录调试:', {
                    name: r.name,
                    sku: r.sku,
                    production_date: r.production_date,
                    remaining_days: remaining,
                    clearance_days: clearanceDays,
                    reminder_days: r.reminder_days,
                    shouldShow: shouldShow,
                    isIgnored: isIgnored
                });
            }
            
            if (shouldShow && !isIgnored) {
                console.log('出清商品:', {
                    name: r.name,
                    sku: r.sku,
                    shelf_life: r.shelf_life,
                    production_date: r.production_date,
                    remaining_days: remaining,
                    clearance_days: clearanceDays,
                    reminder_days: r.reminder_days
                });
            }
            
            return shouldShow && !isIgnored;
        });
        
        console.log('出清计算调试 - 符合条件的商品数:', this.clearance.length);
        this.lastFetch.clearance = Date.now();
        return this.clearance;
    }

    clear() {
        this.products = null;
        this.records = null;
        this.expiring = null;
        this.clearance = null;
        this.lastFetch = { products: 0, records: 0, expiring: 0, clearance: 0 };
        // 清除图片缓存
        imageCacheManager.clear();
    }
}

const dataCache = new DataCache();

// 渲染建议出清表格和卡片
async function renderClearanceTable(forceRefresh = false) {
    const tableBody = document.getElementById('clearanceTable');
    const cardsContainer = document.getElementById('clearanceCardsContainer');
    if (!tableBody || !cardsContainer) return;

    showTableLoading('clearanceTable', true, '加载出清商品...');
    showCardsLoading('clearanceCardsContainer', true, '加载出清商品...');

    try {
        console.log('=== 开始加载建议出清页数据 ===');
        console.log('是否强制刷新:', forceRefresh);
        
        // 直接使用DataCache的getClearance方法，确保逻辑一致
        const clearanceItems = await dataCache.getClearance(forceRefresh);
        
        console.log('DataCache获取的建议出清商品数量:', clearanceItems.length);
        
        if (clearanceItems.length === 0) {
            console.log('警告：没有获取到任何建议出清商品');
        }
        
        // 检查第一条记录的数据结构
        if (clearanceItems.length > 0) {
            console.log('第一条记录示例:', clearanceItems[0]);
        }
        
        // 调试：输出所有商品信息
        console.log('=== 建议出清页调试开始 ===');
        console.log('总商品数量:', clearanceItems.length);
        
        // 重新从localStorage加载忽略列表，确保获取最新状态
        const currentIgnoreList = JSON.parse(localStorage.getItem('clearanceIgnoreList') || '[]');
        console.log('忽略列表:', currentIgnoreList);
        console.log('忽略列表长度:', currentIgnoreList.length);
        
        let filteredItems = clearanceItems.filter(item => {
            const ignoreKey = `${item.sku}_${item.production_date}`;
            const isIgnored = currentIgnoreList.includes(ignoreKey);
            console.log(`检查忽略: ${item.sku}_${item.production_date} - 是否被忽略: ${isIgnored}`);
            return !isIgnored;
        });
        
        console.log('过滤忽略后的商品数量:', filteredItems.length);

        // 按照分类顺序排序: 牛奶类, 面包类, 其他类
        const categoryOrder = {
            '牛奶类': 1,
            '面包类': 2,
            '其他类': 3
        };
        filteredItems.sort((a, b) => {
            const categoryA = a.category || '其他类';
            const categoryB = b.category || '其他类';
            const orderA = categoryOrder[categoryA] || 4;
            const orderB = categoryOrder[categoryB] || 4;
            if (orderA !== orderB) {
                return orderA - orderB;
            } else {
                // 同一分类内按SKU排序
                return a.sku.localeCompare(b.sku);
            }
        });

        // 保存所有数据用于分页
        clearanceAllData = filteredItems;

		// 调试：输出建议出清页的SKU列表
                console.log('建议出清页SKU列表:', filteredItems.map(item => ({ sku: item.sku, remaining: item.remaining_days })));
                console.log('忽略列表:', clearanceIgnoreList);

                // 强制刷新时重置页码
                        if (forceRefresh) {
                            clearanceCurrentPage = 1;
                        }

                        console.log('分页前商品数量:', filteredItems.length);

                        // 根据需求：去除分页加载限制，一次全部刷新，保留分类排序
                        // 计算总页数但不实际分页
                        const pageSize = 10;
                        clearanceTotalPages = Math.ceil(filteredItems.length / pageSize);
                        console.log('计算分页信息 - 总页数:', clearanceTotalPages, '当前页:', clearanceCurrentPage);

                        // 不再分页，一次性加载所有数据
                        console.log('不分页，加载所有商品数量:', filteredItems.length);

                        // 隐藏分页控件（不显示上下页按钮）
                        const paginationContainer = document.getElementById('clearancePagination');
                        if (paginationContainer) {
                            paginationContainer.style.display = 'none';
                        }
        
                // 图片预加载和缓存（只对当前页需要显示的数据进行预加载，优化性能）
                console.log('开始预加载图片，数量:', filteredItems.length);
                const imagePromises = filteredItems.map(item => imageCacheManager.getImageUrl(item.sku));
                const imageResults = await Promise.all(imagePromises);
                console.log('图片预加载完成');
	        
        if (filteredItems.length === 0) {
            console.log('=== 建议出清页没有内容 ===');
            console.log('表格容器:', tableBody);
            console.log('卡片容器:', cardsContainer);
            
            tableBody.innerHTML = `
                <tr>
                    <td colspan="11" class="text-center py-5 text-muted">
                        <i class="bi bi-check-circle" style="font-size: 2rem;"></i>
                        <p class="mt-2">暂无建议出清商品</p>
                    </td>
                </tr>
            `;
            cardsContainer.innerHTML = `
                <div class="text-center py-5 text-muted">
                    <i class="bi bi-check-circle" style="font-size: 2rem;"></i>
                    <p class="mt-2">暂无建议出清商品</p>
                </div>
            `;
            return;
        }
        
        console.log('=== 开始渲染建议出清页 ===');
        console.log('渲染商品数量:', filteredItems.length);

        // 渲染桌面端表格
        let tableHtml = '';
        // 渲染移动端卡片
        let cardsHtml = '';

        for (let i = 0; i < filteredItems.length; i++) {
            const item = filteredItems[i];
            const clearanceDays = calculateClearanceDays(item.shelf_life);
            const clearanceDate = new Date(createBJDate(item.production_date));
            clearanceDate.setUTCDate(clearanceDate.getUTCDate() + item.shelf_life - clearanceDays);
            const clearanceDateStr = formatDateLocal(clearanceDate);
            
            // 获取状态类
            let statusClass = 'normal';
            if (item.remaining_days <= 0) {
                statusClass = 'danger';
            } else {
                const clearanceDays = calculateClearanceDays(item.shelf_life);
                if (item.remaining_days <= clearanceDays) {
                    statusClass = 'warning';
                }
            }

            // 桌面端表格行 - 使用懒加载优化
                        const imageUrl = imageResults[i] || imageCacheManager.getFallbackUrl(item.sku);
                        const lazyImageUrl = imageResults[i] ? imageUrl : imageCacheManager.getFallbackUrl(item.sku);
                        const dataSrc = imageResults[i] ? '' : `data-src="${imageUrl}"`;
            
                        tableHtml += `
                            <tr class="clearance-row" data-sku="${escapeHtml(item.sku)}" data-production-date="${item.production_date}">
                                <td class="image-cell">
            			                        <img src="${lazyImageUrl}" 
            			                             class="product-image-sm" 
            			                             alt="${escapeHtml(item.name)}"
            			                             loading="lazy"
            			                             ${dataSrc}
            			                             onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiBmaWxsPSIjZGRkIi8+Cjx0ZXh0IHg9IjIwIiB5PSIyMCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE0IiBmaWxsPSIjOTk5IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+Tk8gSU1BR0U8L3RleHQ+Cjwvc3ZnPg=='">
                                </td>
                    <td class="sku-cell">${escapeHtml(item.sku)}</td>
                    <td class="product-name-cell">${escapeHtml(item.name)}</td>
                    <td class="category-cell">${escapeHtml(item.category || '其他类')}</td>
                    <td class="location-cell">${escapeHtml(item.location)}</td>
                    <td class="date-cell">${item.production_date}</td>
                    <td class="days-cell">${item.shelf_life}天</td>
                    <td class="days-cell ${statusClass}">${item.remaining_days}</td>
                    <td class="date-cell">${clearanceDateStr}</td>
                    <td class="days-cell">提前${clearanceDays}天</td>
		                    <td class="status-cell">
		                        <button class="btn btn-warning btn-sm ignore-clearance-btn" 
		                                data-sku="${escapeHtml(item.sku)}" 
		                                data-production-date="${item.production_date}">
		                            <i class="bi bi-eye-slash"></i> 忽略
		                        </button>
		                        <button class="btn btn-danger btn-sm clear-item-btn" 
		                                data-sku="${escapeHtml(item.sku)}" 
		                                data-production-date="${item.production_date}">
		                            <i class="bi bi-check-circle"></i> 出清
		                        </button>
		                    </td>
                </tr>
            `;

            // 移动端卡片 - 使用懒加载优化
                                    const cardImageUrl = imageResults[i] || imageCacheManager.getFallbackUrl(item.sku);
                                    const lazyCardImageUrl = imageResults[i] ? cardImageUrl : imageCacheManager.getFallbackUrl(item.sku);
                                    const cardDataSrc = imageResults[i] ? '' : `data-src="${cardImageUrl}"`;
                        
                                    cardsHtml += `
                                        <div class="expiring-card ${statusClass}" data-sku="${escapeHtml(item.sku)}" data-production-date="${item.production_date}">
                                            <div class="card-inner">
                                                <div class="card-header-row">
                                                    <div class="card-sku">${escapeHtml(item.sku)}</div>
                                                    <div class="category-badge ${getCategoryClass(item.category || '其他类')}">${escapeHtml(item.category || '其他类')}</div>
                                                    <div class="card-status ${statusClass === 'danger' ? 'status-danger-bg' : 'status-warning-bg'}">${statusClass === 'danger' ? '已过期' : '临期'}</div>
                                                </div>
                                                <div class="d-flex align-items-start mb-3">
                                                    <div class="d-flex align-items-start">
                                                        ${lazyCardImageUrl ? `<img src="${lazyCardImageUrl}" class="card-image-thumb me-3" alt="${escapeHtml(item.name)}" ${cardDataSrc} loading="lazy" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjYwIiBoZWlnaHQ9IjYwIiBmaWxsPSIjZGRkIi8+Cjx0ZXh0IHg9IjMwIiB5PSIzMCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE0IiBmaWxsPSIjOTk5IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+Tk8gSU1BR0U8L3RleHQ+Cjwvc3ZnPg==';">` : ''}
                                                        <div class="flex-grow-1">
                                                            <div class="card-info-item">
                                                                <div class="card-info-label">商品名称</div>
                                                                <div class="card-info-value name-value">${escapeHtml(item.name)}</div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div class="card-body-grid">
                                                    <div class="card-info-item">
                                                        <div class="card-info-label">📦 库位</div>
                                                        <div class="card-info-value location-value">${escapeHtml(item.location)}</div>
                                                    </div>
                                                    <div class="card-info-item">
                                                        <div class="card-info-label">⏳ 剩余</div>
                                                        <div class="card-info-value days-value">${item.remaining_days}<span class="days-unit">天</span></div>
                                                    </div>
                                                    <div class="card-info-item">
                                                        <div class="card-info-label">📅 生产日期</div>
                                                        <div class="card-info-value date-value">${item.production_date}</div>
                                                    </div>
                                                    <div class="card-info-item">
                                                        <div class="card-info-label">🗓️ 建议出清</div>
                                                        <div class="card-info-value date-value">${clearanceDateStr}</div>
                                                    </div>
                                                </div>
                                                <div class="mt-2 small">
                                                    <span class="text-info">出清规则: 保质期${item.shelf_life}天 → 提前${clearanceDays}天出清</span>
                                                </div>
                                                <div class="d-flex justify-content-between mt-3">
                                                    <button class="btn btn-warning btn-sm ignore-clearance-btn" 
                                                            data-sku="${escapeHtml(item.sku)}" 
                                                            data-production-date="${item.production_date}">
                                                        <i class="bi bi-eye-slash"></i> 忽略
                                                    </button>
                                                    <button class="btn btn-danger btn-sm clear-item-btn" 
                                                            data-sku="${escapeHtml(item.sku)}" 
                                                            data-production-date="${item.production_date}">
                                                        <i class="bi bi-check-circle"></i> 出清
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    `;
        }

        tableBody.innerHTML = tableHtml;
        cardsContainer.innerHTML = cardsHtml;
        
        // 调试信息：检查卡片容器是否更新
        console.log('卡片渲染调试 - 表格行数:', tableHtml.split('</tr>').length - 1, '卡片数量:', cardsHtml.split('expiring-card').length - 1);
        
        // 更新分页信息显示
        updateClearancePaginationInfo();
        
        // 更新菜单栏计数显示
        updateMenuBadgeCounts();
        
        // 绑定按钮事件
        bindClearanceCardButtons();

        // 检查容器样式，诊断显示问题
        const cardsComputedStyle = window.getComputedStyle(cardsContainer);
        console.log('卡片容器样式 - display:', cardsComputedStyle.display, 'visibility:', cardsComputedStyle.visibility, 'height:', cardsComputedStyle.height, 'opacity:', cardsComputedStyle.opacity);

        // 检查桌面端表格容器的样式
        const desktopTable = document.querySelector('.desktop-table');
        if (desktopTable) {
            const desktopTableStyle = window.getComputedStyle(desktopTable);
            console.log('桌面端表格容器样式 - display:', desktopTableStyle.display, 'visibility:', desktopTableStyle.visibility, 'height:', desktopTableStyle.height);
        }

        // 检查建议出清标签页容器的样式
        const clearanceTabPane = document.getElementById('clearance');
        if (clearanceTabPane) {
            const tabPaneStyle = window.getComputedStyle(clearanceTabPane);
            console.log('建议出清标签页容器样式 - display:', tabPaneStyle.display, 'visibility:', tabPaneStyle.visibility, 'height:', tabPaneStyle.height);
        }





        // 绑定分页按钮事件
        bindClearancePaginationButtons();

        // 更新分页信息显示
        updateClearancePaginationInfo();
        
        // 更新菜单栏计数显示
        updateMenuBadgeCounts();

        // 移动端左滑功能已改为按钮，不再需要绑定左滑事件

    } catch (error) {
        console.error('渲染出清商品错误:', error);
        tableBody.innerHTML = `
            <tr>
                <td colspan="11" class="text-center py-5 text-danger">
                    <i class="bi bi-exclamation-triangle" style="font-size: 2rem;"></i>
                    <p class="mt-2">加载出清商品失败</p>
                </td>
            </tr>
        `;
        cardsContainer.innerHTML = `
            <div class="text-center py-5 text-danger">
                <i class="bi bi-exclamation-triangle" style="font-size: 2rem;"></i>
                <p class="mt-2">加载出清商品失败</p>
            </div>
        `;
    } finally {
        showTableLoading('clearanceTable', false);
        showCardsLoading('clearanceCardsContainer', false);
    }
}



// 删除出清记录
async function deleteRecord(sku, productionDate, type = 'clearance') {
    try {
        await apiRequest(`/api/records/${encodeURIComponent(sku)}/${productionDate}`, 'DELETE');
        showQuickToast('删除成功', 'success');
        dataCache.clear();
        
        // 重新渲染相关表格
        await renderExpiringTable(true);
        await renderAllTable(true);
        await renderClearanceTable(true);
        await updateExpiryCount();
        await updateClearanceCount();
        
    } catch (error) {
        showAlert(`删除失败: ${error.message}`, 'danger');
    }
}


// 处理出清商品忽略
async function handleIgnoreClearance(sku, productionDate) {
    // 防止重复点击同一个商品
    const ignoreKey = `${sku}_${productionDate}`;
    if (clearanceIgnoreList.includes(ignoreKey)) {
        console.log('商品已被忽略，跳过处理:', ignoreKey);
        return;
    }
    
    // 添加忽略动画（向左滑动）
    const card = document.querySelector(`.expiring-card[data-sku="${sku}"][data-production-date="${productionDate}"]`);
    if (card) {
        card.classList.add('ignore-animate');
    }
    
    setTimeout(async () => {
        // 获取商品数据（与handleClearItem保持一致）
        const item = clearanceAllData.find(i => i.sku === sku && i.production_date === productionDate);
        if (!item) return;  // 与handleClearItem保持一致
        
        // 注意：忽略的商品不应该添加到待出清表列表，只添加到忽略列表
        // 这里移除了添加到待出清表列表的逻辑
        
        // 添加到忽略列表
        if (!clearanceIgnoreList.includes(ignoreKey)) {
            clearanceIgnoreList.push(ignoreKey);
            localStorage.setItem('clearanceIgnoreList', JSON.stringify(clearanceIgnoreList));
            console.log('已添加到忽略列表:', ignoreKey, '当前忽略列表大小:', clearanceIgnoreList.length);
        }
        
        // 直接移除当前商品元素，而不是刷新整个页面
        const card = document.querySelector(`.expiring-card[data-sku="${sku}"][data-production-date="${productionDate}"]`);
        const tableRow = document.querySelector(`.clearance-row[data-sku="${sku}"][data-production-date="${productionDate}"]`);
        
        if (card) card.remove();
        if (tableRow) tableRow.remove();
        
        // 检查是否需要加载下一页的数据（在元素被移除后立即计算）
        const remainingCards = document.querySelectorAll('#clearanceCardsContainer .expiring-card').length;
        const remainingRows = document.querySelectorAll('#clearanceTable .clearance-row').length;
        
        console.log('忽略按钮处理完成 - 剩余卡片:', remainingCards, '剩余行:', remainingRows);
        
        // 强制延迟一小段时间以确保localStorage同步
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // 使用通用的刷新逻辑
        await commonClearanceRefreshLogic(remainingCards, remainingRows);
        
        // 更新建议出清标签页的动态数字显示
        await updateClearanceCount(true);
        
        // 更新待出清表标签页的动态数字显示（但不更新菜单按钮）- 与handleClearItem保持一致
        await updateRecentClearanceCountBadgeOnly();
        
        // 立即更新菜单栏数字显示，指定当前页面类型为建议出清页
        window.currentActivePage = 'clearance';
        updateMenuBadgeCounts();
        // 清除临时标记
        setTimeout(() => { delete window.currentActivePage; }, 100);
        
        // 显示忽略成功提示（确保只显示一次）
        if (!window.lastIgnoreToastTime || Date.now() - window.lastIgnoreToastTime > 1000) {
            showQuickToast('商品已忽略', 'success');
            window.lastIgnoreToastTime = Date.now();
        }
    }, 300);
}

// 通用的建议出清页刷新逻辑 - 优化为静默刷新
			async function commonClearanceRefreshLogic(remainingCards, remainingRows) {
			    console.log('刷新逻辑 - 当前页:', clearanceCurrentPage, '总页数:', clearanceTotalPages, '剩余卡片:', remainingCards, '剩余行:', remainingRows);
				    
			    // 只有当当前页面没有剩余元素时才刷新数据
			    if (remainingCards === 0 && remainingRows === 0) {
			        console.log('当前页面无剩余元素，静默刷新');
			        // 刷新数据，确保获取最新的出清商品列表
			        dataCache.clear();
			        // 重置到第一页，因为当前页已无内容
			        clearanceCurrentPage = 1;
			        // 使用静默刷新，不显示加载状态
			        await renderClearanceTableSilently(true);
			    } else {
			        // 如果页面还有内容，则不重新渲染，保持静默
			        console.log('当前页面仍有元素，保持静默状态');
			        // 只更新分页信息，不重新渲染
			        updateClearancePaginationInfo();
			    }
			}

// 处理出清商品
	async function handleClearItem(sku, productionDate) {
	    // 找到对应的商品数据
	    const item = clearanceAllData.find(i => i.sku === sku && i.production_date === productionDate);
	    if (!item) return;
	    
	    // 添加出清动画（向右滑动）
	    const card = document.querySelector(`.expiring-card[data-sku="${sku}"][data-production-date="${productionDate}"]`);
	    if (card) {
	        card.classList.add('clear-animate');
	    }
	    
	    setTimeout(async () => {
	        // 创建出清记录
	        const clearRecord = {
	            ...item,
	            clear_timestamp: Date.now(),
	            clear_date: new Date().toISOString().split('T')[0]
	        };
	        
	        // 添加到待出清表列表（检查重复）
	        const existingRecord = recentClearanceList.find(record => 
	            record.sku === sku && record.production_date === productionDate
	        );
	        if (!existingRecord) {
	            recentClearanceList.push(clearRecord);
	            localStorage.setItem('recentClearanceList', JSON.stringify(recentClearanceList));
	        }
	        
	        // 同时添加到忽略列表，避免再次显示在建议出清页
	        const ignoreKey = `${sku}_${productionDate}`;
	        if (!clearanceIgnoreList.includes(ignoreKey)) {
	            clearanceIgnoreList.push(ignoreKey);
	            localStorage.setItem('clearanceIgnoreList', JSON.stringify(clearanceIgnoreList));
	        }
	        
	        // 移除当前商品元素
	        const card = document.querySelector(`.expiring-card[data-sku="${sku}"][data-production-date="${productionDate}"]`);
	        const tableRow = document.querySelector(`.clearance-row[data-sku="${sku}"][data-production-date="${productionDate}"]`);
	        
	        if (card) card.remove();
	        if (tableRow) tableRow.remove();
	        
	        // 检查是否需要加载下一页的数据（在元素被移除后立即计算）
	        const remainingCards = document.querySelectorAll('#clearanceCardsContainer .expiring-card').length;
	        const remainingRows = document.querySelectorAll('#clearanceTable .clearance-row').length;
	        
									console.log('出清按钮处理完成 - 剩余卡片:', remainingCards, '剩余行:', remainingRows);
		        
											        // 强制延迟一小段时间以确保localStorage同步
											        await new Promise(resolve => setTimeout(resolve, 50));
		        
											        // 使用通用的刷新逻辑
											        await commonClearanceRefreshLogic(remainingCards, remainingRows);
	        
        // 更新建议出清标签页的动态数字显示
        await updateClearanceCount(true);
        
        // 更新待出清表标签页的动态数字显示（但不更新菜单按钮）
        await updateRecentClearanceCountBadgeOnly();
        
        // 立即更新菜单栏数字显示，指定当前页面类型为建议出清页
        window.currentActivePage = 'clearance';
        updateMenuBadgeCounts();
        // 清除临时标记
        setTimeout(() => { delete window.currentActivePage; }, 100);
        
        // 显示出清成功提示（确保只显示一次）
        if (!window.lastClearToastTime || Date.now() - window.lastClearToastTime > 1000) {
            showQuickToast('已添加到待出清表', 'success');
            window.lastClearToastTime = Date.now();
        }
	    }, 300);
	}

// 处理确认出清
function handleConfirmClearance(sku, productionDate) {
    // 添加淡出动画
    const card = document.querySelector(`.expiring-card[data-sku="${sku}"][data-production-date="${productionDate}"]`);
    if (card) {
        card.classList.add('fade-out');
    }
    
    setTimeout(() => {
        // 从待出清表列表中移除
        recentClearanceList = recentClearanceList.filter(record => 
            !(record.sku === sku && record.production_date === productionDate)
        );
        localStorage.setItem('recentClearanceList', JSON.stringify(recentClearanceList));
        
        // 移除当前商品元素
        const card = document.querySelector(`.expiring-card[data-sku="${sku}"][data-production-date="${productionDate}"]`);
        const tableRow = document.querySelector(`#recentClearanceTable tr[data-sku="${sku}"][data-production-date="${productionDate}"]`);
        
        if (card) card.remove();
        if (tableRow) tableRow.remove();
        
        // 重新渲染待出清表页，确保显示更新
        renderRecentClearanceTable();
        
        // 更新菜单栏计数显示
        updateMenuBadgeCounts();
        
        // 更新待出清表计数
        updateRecentClearanceCount();
        
        // 显示确认成功提示
        showQuickToast('已确认出清', 'success');
    }, 300);
}

// 清空当天出清记录
function clearTodayClearance() {
    const today = getBJToday().toISOString().split('T')[0]; // 使用北京时间
    const originalLength = recentClearanceList.length;
        
    // 过滤掉今天的记录
    recentClearanceList = recentClearanceList.filter(record => {
        // 确保比较的是同一天（忽略时间部分）
        const recordDate = new Date(createBJDate(record.clear_date));
        const todayDate = new Date(createBJDate(today));
        return !(recordDate.toISOString().split('T')[0] === todayDate.toISOString().split('T')[0]);
    });
    localStorage.setItem('recentClearanceList', JSON.stringify(recentClearanceList));
        
    const removedCount = originalLength - recentClearanceList.length;
        
    if (removedCount > 0) {
        showQuickToast(`已清空 ${removedCount} 条当天出清记录`, 'success');
        // 重新渲染待出清表页
        renderRecentClearanceTable();
        // 更新待出清表计数
        updateRecentClearanceCount();
    } else {
        showQuickToast('当天没有出清记录可清除', 'info');
    }
}

// 渲染待出清表标签页
async function renderRecentClearanceTable() {
    const tableBody = document.getElementById('recentClearanceTable');
    const cardsContainer = document.getElementById('recentClearanceCardsContainer');
    if (!tableBody || !cardsContainer) return;
    
    // 预加载待出清表商品的图片（使用优化的图片缓存管理器）
    const imagePromises = recentClearanceList.map(record => {
        return imageCacheManager.getImageUrl(record.sku);
    });
    const imageResults = await Promise.all(imagePromises);
    
	    // 清理过期记录（3天前）
	    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
	    recentClearanceList = recentClearanceList.filter(record => record.clear_timestamp > threeDaysAgo);
	    localStorage.setItem('recentClearanceList', JSON.stringify(recentClearanceList));
    
    if (recentClearanceList.length === 0) {
        tableBody.innerHTML = `
            <tr>
                <td colspan="11" class="text-center py-5 text-muted">
                    <i class="bi bi-clock" style="font-size: 2rem;"></i>
                    <p class="mt-2">暂无待出清记录</p>
                    <small>出清记录会保留3天</small>
                </td>
            </tr>
        `;
        cardsContainer.innerHTML = `
            <div class="text-center py-5 text-muted">
                <i class="bi bi-clock" style="font-size: 2rem;"></i>
                <p class="mt-2">暂无待出清记录</p>
                <small>出清记录会保留3天</small>
            </div>
        `;
        return;
    }
    
    // 渲染桌面端表格
    let tableHtml = '';
    // 渲染移动端卡片
    let cardsHtml = '';
    
    for (let i = 0; i < recentClearanceList.length; i++) {
        const record = recentClearanceList[i];
        const clearanceDays = calculateClearanceDays(record.shelf_life);
        const clearanceDate = new Date(createBJDate(record.production_date));
        clearanceDate.setUTCDate(clearanceDate.getUTCDate() + record.shelf_life - clearanceDays);
        const clearanceDateStr = formatDateLocal(clearanceDate);
        
        // 桌面端表格行
        const imageUrl = imageResults[i] || imageCacheManager.getFallbackUrl(record.sku);
        tableHtml += `
            <tr>
                <td class="image-cell">
                    <img src="${imageUrl}"
                         class="product-image-sm" 
                         alt="${escapeHtml(record.name)}"
                         onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiBmaWxsPSIjZGRkIi8+Cjx0ZXh0IHg9IjIwIiB5PSIyMCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE0IiBmaWxsPSIjOTk5IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+Tk8gSU1BR0U8L3RleHQ+Cjwvc3ZnPg=='">
                </td>
                <td class="sku-cell">${escapeHtml(record.sku)}</td>
                <td class="product-name-cell">${escapeHtml(record.name)}</td>
                <td class="category-cell">${escapeHtml(record.category || '其他类')}</td>
                <td class="location-cell">${escapeHtml(record.location)}</td>
                <td class="date-cell">${record.production_date}</td>
                <td class="days-cell">${record.shelf_life}天</td>
                <td class="days-cell">${record.remaining_days}</td>
                <td class="date-cell">${clearanceDateStr}</td>
                <td class="days-cell">提前${clearanceDays}天</td>
                <td class="date-cell">${record.clear_date}</td>
            </tr>
        `;
        
        // 移动端卡片
        const cardImageUrl = imageResults[i] || imageCacheManager.getFallbackUrl(record.sku);
        cardsHtml += `
            <div class="expiring-card" data-sku="${escapeHtml(record.sku)}" data-production-date="${record.production_date}">
                <div class="card-inner">
                    <div class="card-header-row">
                        <div class="card-sku">${escapeHtml(record.sku)}</div>
                        <div class="category-badge ${getCategoryClass(record.category || '其他类')}">${escapeHtml(record.category || '其他类')}</div>
                        <div class="card-status status-warning-bg">待出清</div>
                    </div>
                    <div class="d-flex align-items-start mb-3">
                        <div class="d-flex align-items-start">
                            ${cardImageUrl ? `<img src="${cardImageUrl}" class="card-image-thumb me-3" alt="${escapeHtml(record.name)}" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjYwIiBoZWlnaHQ9IjYwIiBmaWxsPSIjZGRkIi8+Cjx0ZXh0IHg9IjMwIiB5PSIzMCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE0IiBmaWxsPSIjOTk5IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+Tk8gSU1BR0U8L3RleHQ+Cjwvc3ZnPg==';">` : ''}
                            <div class="flex-grow-1">
                                <div class="card-info-item">
                                    <div class="card-info-label">商品名称</div>
                                    <div class="card-info-value name-value">${escapeHtml(record.name)}</div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="card-body-grid">
                        <div class="card-info-item">
                            <div class="card-info-label">📅 生产日期</div>
                            <div class="card-info-value date-value">${record.production_date}</div>
                        </div>
                        <div class="card-info-item">
                            <div class="card-info-label">⏳ 剩余</div>
                            <div class="card-info-value days-value">${record.remaining_days}<span class="days-unit">天</span></div>
                        </div>
                        <div class="card-info-item">
                            <div class="card-info-label">🗓️ 建议出清</div>
                            <div class="card-info-value date-value">${clearanceDateStr}</div>
                        </div>
                        <div class="card-info-item">
                            <div class="card-info-label">📏 出清规则</div>
                            <div class="card-info-value">提前${clearanceDays}天</div>
                        </div>
                    </div>
                    <div class="d-flex justify-content-center mt-3">
                        <button class="btn btn-success btn-sm confirm-clearance-btn" 
                                data-sku="${escapeHtml(record.sku)}" 
                                data-production-date="${record.production_date}">
                            <i class="bi bi-check-circle"></i> 确认出清
                        </button>
                    </div>
                </div>
            </div>
        `;
    }
    
    tableBody.innerHTML = tableHtml;
    cardsContainer.innerHTML = cardsHtml;
    
    // 事件委托已经在DOM加载时绑定，无需在此处重复绑定
}

// 更新出清页面分页信息
function updateClearancePaginationInfo() {
    const pageInfo = document.getElementById('clearancePageInfo');
    if (pageInfo) {
        pageInfo.textContent = `第 ${clearanceCurrentPage} 页 / 共 ${clearanceTotalPages} 页`;
    }
}

// 静默渲染建议出清页 - 不显示加载状态
async function renderClearanceTableSilently(forceRefresh = false) {
    const tableBody = document.getElementById('clearanceTable');
    const cardsContainer = document.getElementById('clearanceCardsContainer');
    if (!tableBody || !cardsContainer) return;

    try {
        console.log('=== 静默加载建议出清页数据 ===');
        console.log('是否强制刷新:', forceRefresh);
        
        // 直接使用DataCache的getClearance方法，确保逻辑一致
        const clearanceItems = await dataCache.getClearance(forceRefresh);
        
        console.log('DataCache获取的建议出清商品数量:', clearanceItems.length);
        
        if (clearanceItems.length === 0) {
            console.log('警告：没有获取到任何建议出清商品');
        }
        
        // 检查第一条记录的数据结构
        if (clearanceItems.length > 0) {
            console.log('第一条记录示例:', clearanceItems[0]);
        }
        
        // 调试：输出所有商品信息
        console.log('=== 建议出清页调试开始 ===');
        console.log('总商品数量:', clearanceItems.length);
        
        // 重新从localStorage加载忽略列表，确保获取最新状态
        const currentIgnoreList = JSON.parse(localStorage.getItem('clearanceIgnoreList') || '[]');
        console.log('忽略列表:', currentIgnoreList);
        console.log('忽略列表长度:', currentIgnoreList.length);
        
        let filteredItems = clearanceItems.filter(item => {
            const ignoreKey = `${item.sku}_${item.production_date}`;
            const isIgnored = currentIgnoreList.includes(ignoreKey);
            console.log(`检查忽略: ${item.sku}_${item.production_date} - 是否被忽略: ${isIgnored}`);
            return !isIgnored;
        });
        
        console.log('过滤忽略后的商品数量:', filteredItems.length);

        // 按照分类顺序排序: 牛奶类, 面包类, 其他类
        const categoryOrder = {
            '牛奶类': 1,
            '面包类': 2,
            '其他类': 3
        };
        filteredItems.sort((a, b) => {
            const categoryA = a.category || '其他类';
            const categoryB = b.category || '其他类';
            const orderA = categoryOrder[categoryA] || 4;
            const orderB = categoryOrder[categoryB] || 4;
            if (orderA !== orderB) {
                return orderA - orderB;
            } else {
                // 同一分类内按SKU排序
                return a.sku.localeCompare(b.sku);
            }
        });

        // 保存所有数据用于分页
        clearanceAllData = filteredItems;

		// 调试：输出建议出清页的SKU列表
                console.log('建议出清页SKU列表:', filteredItems.map(item => ({ sku: item.sku, remaining: item.remaining_days })));
                console.log('忽略列表:', clearanceIgnoreList);

                // 强制刷新时重置页码
                        if (forceRefresh) {
                            clearanceCurrentPage = 1;
                        }

                        console.log('分页前商品数量:', filteredItems.length);

                        // 根据需求：去除分页加载限制，一次全部刷新，保留分类排序
                        // 计算总页数但不实际分页
                        const pageSize = 10;
                        clearanceTotalPages = Math.ceil(filteredItems.length / pageSize);
                        console.log('计算分页信息 - 总页数:', clearanceTotalPages, '当前页:', clearanceCurrentPage);

                        // 不再分页，一次性加载所有数据
                        console.log('不分页，加载所有商品数量:', filteredItems.length);

                        // 隐藏分页控件（不显示上下页按钮）
                        const paginationContainer = document.getElementById('clearancePagination');
                        if (paginationContainer) {
                            paginationContainer.style.display = 'none';
                        }
        
                // 图片预加载和缓存（只对当前页需要显示的数据进行预加载，优化性能）
                console.log('开始预加载图片，数量:', filteredItems.length);
                const imagePromises = filteredItems.map(item => imageCacheManager.getImageUrl(item.sku));
                const imageResults = await Promise.all(imagePromises);
                console.log('图片预加载完成');
		        
        if (filteredItems.length === 0) {
            console.log('=== 建议出清页没有内容 ===');
            console.log('表格容器:', tableBody);
            console.log('卡片容器:', cardsContainer);
            
            tableBody.innerHTML = `
                <tr>
                    <td colspan="11" class="text-center py-5 text-muted">
                        <i class="bi bi-check-circle" style="font-size: 2rem;"></i>
                        <p class="mt-2">暂无建议出清商品</p>
                    </td>
                </tr>
            `;
            cardsContainer.innerHTML = `
                <div class="text-center py-5 text-muted">
                    <i class="bi bi-check-circle" style="font-size: 2rem;"></i>
                    <p class="mt-2">暂无建议出清商品</p>
                </div>
            `;
            return;
        }
        
        console.log('=== 开始静默渲染建议出清页 ===');
        console.log('渲染商品数量:', filteredItems.length);

        // 渲染桌面端表格
        let tableHtml = '';
        // 渲染移动端卡片
        let cardsHtml = '';

        for (let i = 0; i < filteredItems.length; i++) {
            const item = filteredItems[i];
            const clearanceDays = calculateClearanceDays(item.shelf_life);
            const clearanceDate = new Date(createBJDate(item.production_date));
            clearanceDate.setUTCDate(clearanceDate.getUTCDate() + item.shelf_life - clearanceDays);
            const clearanceDateStr = formatDateLocal(clearanceDate);
            
            // 获取状态类
            let statusClass = 'normal';
            if (item.remaining_days <= 0) {
                statusClass = 'danger';
            } else {
                const clearanceDays = calculateClearanceDays(item.shelf_life);
                if (item.remaining_days <= clearanceDays) {
                    statusClass = 'warning';
                }
            }

            // 桌面端表格行 - 使用懒加载优化
                        const imageUrl = imageResults[i] || imageCacheManager.getFallbackUrl(item.sku);
                        const lazyImageUrl = imageResults[i] ? imageUrl : imageCacheManager.getFallbackUrl(item.sku);
                        const dataSrc = imageResults[i] ? '' : `data-src="${imageUrl}"`;
            
                        tableHtml += `
                            <tr class="clearance-row" data-sku="${escapeHtml(item.sku)}" data-production-date="${item.production_date}">
                                <td class="image-cell">
            			                        <img src="${lazyImageUrl}" 
            			                             class="product-image-sm" 
            			                             alt="${escapeHtml(item.name)}"
            			                             loading="lazy"
            			                             ${dataSrc}
            			                             onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiBmaWxsPSIjZGRkIi8+Cjx0ZXh0IHg9IjIwIiB5PSIyMCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE0IiBmaWxsPSIjOTk5IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+Tk8gSU1BR0U8L3RleHQ+Cjwvc3ZnPg=='">
                                </td>
                    <td class="sku-cell">${escapeHtml(item.sku)}</td>
                    <td class="product-name-cell">${escapeHtml(item.name)}</td>
                    <td class="category-cell">${escapeHtml(item.category || '其他类')}</td>
                    <td class="location-cell">${escapeHtml(item.location)}</td>
                    <td class="date-cell">${item.production_date}</td>
                    <td class="days-cell">${item.shelf_life}天</td>
                    <td class="days-cell ${statusClass}">${item.remaining_days}</td>
                    <td class="date-cell">${clearanceDateStr}</td>
                    <td class="days-cell">提前${clearanceDays}天</td>
			                    <td class="status-cell">
			                        <button class="btn btn-warning btn-sm ignore-clearance-btn" 
			                                data-sku="${escapeHtml(item.sku)}" 
			                                data-production-date="${item.production_date}">
			                            <i class="bi bi-eye-slash"></i> 忽略
			                        </button>
			                        <button class="btn btn-danger btn-sm clear-item-btn" 
			                                data-sku="${escapeHtml(item.sku)}" 
			                                data-production-date="${item.production_date}">
			                            <i class="bi bi-check-circle"></i> 出清
			                        </button>
			                    </td>
                </tr>
            `;

            // 移动端卡片 - 使用懒加载优化
                                    const cardImageUrl = imageResults[i] || imageCacheManager.getFallbackUrl(item.sku);
                                    const lazyCardImageUrl = imageResults[i] ? cardImageUrl : imageCacheManager.getFallbackUrl(item.sku);
                                    const cardDataSrc = imageResults[i] ? '' : `data-src="${cardImageUrl}"`;
                        
                                    cardsHtml += `
                                        <div class="expiring-card ${statusClass}" data-sku="${escapeHtml(item.sku)}" data-production-date="${item.production_date}">
                                            <div class="card-inner">
                                                <div class="card-header-row">
                                                    <div class="card-sku">${escapeHtml(item.sku)}</div>
                                                    <div class="category-badge ${getCategoryClass(item.category || '其他类')}">${escapeHtml(item.category || '其他类')}</div>
                                                    <div class="card-status ${statusClass === 'danger' ? 'status-danger-bg' : 'status-warning-bg'}">${statusClass === 'danger' ? '已过期' : '临期'}</div>
                                                </div>
                                                <div class="d-flex align-items-start mb-3">
                                                    <div class="d-flex align-items-start">
                                                        ${lazyCardImageUrl ? `<img src="${lazyCardImageUrl}" class="card-image-thumb me-3" alt="${escapeHtml(item.name)}" ${cardDataSrc} loading="lazy" onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjYwIiBoZWlnaHQ9IjYwIiBmaWxsPSIjZGRkIi8+Cjx0ZXh0IHg9IjMwIiB5PSIzMCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE0IiBmaWxsPSIjOTk5IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+Tk8gSU1BR0U8L3RleHQ+Cjwvc3ZnPg==';">` : ''}
                                                        <div class="flex-grow-1">
                                                            <div class="card-info-item">
                                                                <div class="card-info-label">商品名称</div>
                                                                <div class="card-info-value name-value">${escapeHtml(item.name)}</div>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                                <div class="card-body-grid">
                                                    <div class="card-info-item">
                                                        <div class="card-info-label">📦 库位</div>
                                                        <div class="card-info-value location-value">${escapeHtml(item.location)}</div>
                                                    </div>
                                                    <div class="card-info-item">
                                                        <div class="card-info-label">⏳ 剩余</div>
                                                        <div class="card-info-value days-value">${item.remaining_days}<span class="days-unit">天</span></div>
                                                    </div>
                                                    <div class="card-info-item">
                                                        <div class="card-info-label">📅 生产日期</div>
                                                        <div class="card-info-value date-value">${item.production_date}</div>
                                                    </div>
                                                    <div class="card-info-item">
                                                        <div class="card-info-label">🗓️ 建议出清</div>
                                                        <div class="card-info-value date-value">${clearanceDateStr}</div>
                                                    </div>
                                                </div>
                                                <div class="mt-2 small">
                                                    <span class="text-info">出清规则: 保质期${item.shelf_life}天 → 提前${clearanceDays}天出清</span>
                                                </div>
                                                <div class="d-flex justify-content-between mt-3">
                                                    <button class="btn btn-warning btn-sm ignore-clearance-btn" 
                                                            data-sku="${escapeHtml(item.sku)}" 
                                                            data-production-date="${item.production_date}">
                                                        <i class="bi bi-eye-slash"></i> 忽略
                                                    </button>
                                                    <button class="btn btn-danger btn-sm clear-item-btn" 
                                                            data-sku="${escapeHtml(item.sku)}" 
                                                            data-production-date="${item.production_date}">
                                                        <i class="bi bi-check-circle"></i> 出清
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                    `;
        }

        tableBody.innerHTML = tableHtml;
        cardsContainer.innerHTML = cardsHtml;
        
        // 调试信息：检查卡片容器是否更新
        console.log('卡片渲染调试 - 表格行数:', tableHtml.split('</tr>').length - 1, '卡片数量:', cardsHtml.split('expiring-card').length - 1);
        
        // 更新分页信息显示
        updateClearancePaginationInfo();
        
        // 更新菜单栏计数显示
        updateMenuBadgeCounts();
        
        // 绑定按钮事件
        bindClearanceCardButtons();

        // 检查容器样式，诊断显示问题
        const cardsComputedStyle = window.getComputedStyle(cardsContainer);
        console.log('卡片容器样式 - display:', cardsComputedStyle.display, 'visibility:', cardsComputedStyle.visibility, 'height:', cardsComputedStyle.height, 'opacity:', cardsComputedStyle.opacity);

        // 检查桌面端表格容器的样式
        const desktopTable = document.querySelector('.desktop-table');
        if (desktopTable) {
            const desktopTableStyle = window.getComputedStyle(desktopTable);
            console.log('桌面端表格容器样式 - display:', desktopTableStyle.display, 'visibility:', desktopTableStyle.visibility, 'height:', desktopTableStyle.height);
        }

        // 检查建议出清标签页容器的样式
        const clearanceTabPane = document.getElementById('clearance');
        if (clearanceTabPane) {
            const tabPaneStyle = window.getComputedStyle(clearanceTabPane);
            console.log('建议出清标签页容器样式 - display:', tabPaneStyle.display, 'visibility:', tabPaneStyle.visibility, 'height:', tabPaneStyle.height);
        }

        // 绑定分页按钮事件
        bindClearancePaginationButtons();

        // 更新分页信息显示
        updateClearancePaginationInfo();
        
        // 更新菜单栏计数显示
        updateMenuBadgeCounts();

        // 移动端左滑功能已改为按钮，不再需要绑定左滑事件

    } catch (error) {
        console.error('静默渲染出清商品错误:', error);
        tableBody.innerHTML = `
            <tr>
                <td colspan="11" class="text-center py-5 text-danger">
                    <i class="bi bi-exclamation-triangle" style="font-size: 2rem;"></i>
                    <p class="mt-2">加载出清商品失败</p>
                </td>
            </tr>
        `;
        cardsContainer.innerHTML = `
            <div class="text-center py-5 text-danger">
                <i class="bi bi-exclamation-triangle" style="font-size: 2rem;"></i>
                <p class="mt-2">加载出清商品失败</p>
            </div>
        `;
    }
}

// 绑定出清页面按钮事件
// 使用命名函数确保事件只绑定一次
function handleClearanceCardClick(e) {
    if (e.target.classList.contains('clear-item-btn') || e.target.closest('.clear-item-btn')) {
        const btn = e.target.classList.contains('clear-item-btn') ? e.target : e.target.closest('.clear-item-btn');
        const sku = btn.getAttribute('data-sku');
        const productionDate = btn.getAttribute('data-production-date');
        handleClearItem(sku, productionDate);
    } else if (e.target.classList.contains('ignore-clearance-btn') || e.target.closest('.ignore-clearance-btn')) {
        const btn = e.target.classList.contains('ignore-clearance-btn') ? e.target : e.target.closest('.ignore-clearance-btn');
        const sku = btn.getAttribute('data-sku');
        const productionDate = btn.getAttribute('data-production-date');
        handleIgnoreClearance(sku, productionDate);
    } else if (e.target.classList.contains('confirm-clearance-btn') || e.target.closest('.confirm-clearance-btn')) {
        const btn = e.target.classList.contains('confirm-clearance-btn') ? e.target : e.target.closest('.confirm-clearance-btn');
        const sku = btn.getAttribute('data-sku');
        const productionDate = btn.getAttribute('data-production-date');
        handleConfirmClearance(sku, productionDate);
    }
}

function bindClearanceCardButtons() {
    // 先移除之前的事件监听器，再绑定新的，确保只绑定一次
    document.removeEventListener('click', handleClearanceCardClick);
    document.addEventListener('click', handleClearanceCardClick);
}

// 绑定出清页面分页按钮
function bindClearancePaginationButtons() {
    const prevBtn = document.getElementById('clearancePrevBtn');
    const nextBtn = document.getElementById('clearanceNextBtn');
    const pageInfo = document.getElementById('clearancePageInfo');

    if (prevBtn) {
        prevBtn.onclick = () => {
            console.log('上一页点击 - 当前页:', clearanceCurrentPage, '总页数:', clearanceTotalPages);
            if (clearanceCurrentPage > 1) {
                clearanceCurrentPage--;
                renderClearanceTable();
            } else {
                // 如果已经在第一页，确保页码不会小于1
                clearanceCurrentPage = 1;
                renderClearanceTable();
            }
        };
    }

    if (nextBtn) {
        nextBtn.onclick = () => {
            console.log('下一页点击 - 当前页:', clearanceCurrentPage, '总页数:', clearanceTotalPages);
            if (clearanceCurrentPage < clearanceTotalPages) {
                clearanceCurrentPage++;
                console.log('下一页按钮 - 更新后页码:', clearanceCurrentPage);
                renderClearanceTable(); // 不强制刷新，使用缓存数据
            } else {
                // 如果已经在最后一页，重新渲染确保状态正确
                console.log('下一页按钮 - 已在最后一页');
                renderClearanceTable();
            }
        };
    }

    // 更新分页信息
    updateClearancePaginationInfo();
}



// 初始化出清卡片左滑删除
function initializeClearanceSwipeDelete() {
    const clearanceCards = document.querySelectorAll('#clearanceCardsContainer .expiring-card');
    
    clearanceCards.forEach(card => {
        let startX = 0;
        let currentX = 0;
        let isSwiping = false;
        
        card.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            currentX = startX;
            isSwiping = true;
            card.classList.add('swiping');
        });
        
        card.addEventListener('touchmove', (e) => {
            if (!isSwiping) return;
            currentX = e.touches[0].clientX;
            const diff = startX - currentX;
            
            if (diff > 0) {
                const translateX = Math.min(diff, 80);
                card.querySelector('.card-inner').style.transform = `translateX(-${translateX}px)`;
            }
        });
        
        card.addEventListener('touchend', () => {
            if (!isSwiping) return;
            isSwiping = false;
            
            const diff = startX - currentX;
            if (diff > 50) {
                // 左滑距离足够，触发删除
                const sku = card.getAttribute('data-sku');
                const productionDate = card.getAttribute('data-production-date');
                
                if (confirm(`确定要删除商品 ${sku} 的生产记录 ${productionDate} 吗？`)) {
                    card.classList.add('delete-animate');
                    setTimeout(() => {
                        deleteRecord(sku, productionDate, 'clearance');
                    }, 300);
                } else {
                    // 取消删除，恢复位置
                    card.querySelector('.card-inner').style.transform = 'translateX(0)';
                }
            } else {
                // 滑动距离不足，恢复位置
                card.querySelector('.card-inner').style.transform = 'translateX(0)';
            }
            
            card.classList.remove('swiping');
        });
    });
}

// DOM元素 - 延迟初始化以确保DOM完全加载
let loginContainer, mainApp, loginBtn, registerBtn, logoutBtn, currentUsername, expiryWarningBar, expiryWarningText;
let skuInput, productName, shelfLife, reminderDays, productCategory, productionDate, expiryDate;
let reminderDate, remainingDays, statusIndicator, saveBtn, existingDateHint, productLocation;
let expiringTable, allTable, clearanceTable, clearanceCardsContainer, productDatabaseTable;
let searchSku, searchBtn, newSku, newName, newShelfLife, newReminderDays, newCategory, newLocation, addProductBtn, updateProductBtn;

const imageUploadArea = document.getElementById('imageUploadArea');
const productImageInput = document.getElementById('productImageInput');
const imagePreviewContainer = document.getElementById('imagePreviewContainer');
const removeImageBtn = document.getElementById('removeImageBtn');

let confirmModal, duplicateModal, scannerModal, imagePreviewModal, resetPasswordModal, validityModal, editCodeModal, changePwdModal, verifyPasswordModal;

let currentSelectedItem = null;
let deleteType = '';
let duplicateCheckResult = null;
let isEditingProduct = false;
let currentEditingSku = '';
let hadExistingImage = false;
let currentImageData = null;
let currentImageMime = null;
let html5QrCode = null;
let currentScanCallback = null;
let currentUserRole = null;
let lastAuthCheck = 0;
const AUTH_CHECK_INTERVAL = 300000;

let autoSaveTimer = null;
let cancelAutoSaveFlag = false;
let authCheckerInterval = null;
let isShowingLoginAlert = false;
let appInitialized = false;

let animationTimeout = null;

// 样式
(function addToastStyles() {
    if (!document.querySelector('#toast-animation-style')) {
        const style = document.createElement('style');
        style.id = 'toast-animation-style';
        style.textContent = `
            @keyframes fadeInUp {
                from { opacity: 0; transform: translateX(-50%) translateY(20px); }
                to { opacity: 1; transform: translateX(-50%) translateY(0); }
            }
            @keyframes fadeOutDown {
                from { opacity: 1; transform: translateX(-50%) translateY(0); }
                to { opacity: 0; transform: translateX(-50%) translateY(20px); }
            }
            .quick-toast {
                position: fixed;
                bottom: 80px;
                left: 50%;
                transform: translateX(-50%);
                z-index: 1070;
                min-width: 200px;
                text-align: center;
                padding: 8px 16px;
                font-size: 14px;
                border-radius: 20px;
                box-shadow: 0 2px 10px rgba(0,0,0,0.2);
                animation: fadeInUp 0.2s ease;
                pointer-events: none;
                background: rgba(0,0,0,0.8);
                color: white;
            }
            .quick-toast.alert-success { background: #28a745; color: white; }
            .quick-toast.alert-danger { background: #dc3545; color: white; }
            .quick-toast.alert-warning { background: #ffc107; color: #333; }
            .quick-toast.alert-info { background: #17a2b8; color: white; }
            .product-database-table td {
                vertical-align: middle !important;
            }
            .product-database-table .btn-sm {
                padding: 4px 8px;
                font-size: 12px;
                margin: 2px;
            }
            .product-database-table img.product-image {
                width: 40px;
                height: 40px;
                object-fit: cover;
                border-radius: 6px;
            }
            .pagination-container {
                display: flex;
                justify-content: center;
                align-items: center;
                gap: 10px;
                padding: 15px;
                flex-wrap: wrap;
                border-top: 1px solid #dee2e6;
            }
            .pagination-container .btn-sm {
                min-width: 70px;
            }
            .page-info {
                font-size: 14px;
                color: #666;
            }
            .deleted-item-card {
                background: #f8f9fa;
                border-radius: 12px;
                padding: 12px;
                margin-bottom: 10px;
                border-left: 4px solid #6c757d;
            }
            .deleted-item-card .deleted-item-name {
                font-weight: 600;
                font-size: 1rem;
            }
            .deleted-item-card .deleted-item-info {
                font-size: 12px;
                color: #6c757d;
                margin-top: 5px;
            }
            .deleted-item-card .btn-group-sm {
                gap: 5px;
            }
            .category-filter {
                padding: 10px;
                background: #f8f9fa;
                border-radius: 8px;
                margin-bottom: 15px;
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                align-items: center;
            }
            .category-filter .btn-group {
                flex-wrap: wrap;
                gap: 8px;
            }
            .category-filter .btn {
                border-radius: 20px;
                padding: 4px 16px;
                font-size: 13px;
            }
        `;
        document.head.appendChild(style);
    }
})();

function showQuickToast(message, type = 'info') {
    const types = { 
        info: 'alert-info', 
        success: 'alert-success', 
        warning: 'alert-warning', 
        danger: 'alert-danger' 
    };
    
    const existing = document.querySelector('.quick-toast');
    if (existing) existing.remove();
    
    const div = document.createElement('div');
    div.className = `quick-toast ${types[type]}`;
    const icon = type === 'success' ? 'bi-check-circle' : type === 'danger' ? 'bi-exclamation-triangle' : 'bi-info-circle';
    div.innerHTML = `<i class="bi ${icon} me-1"></i> ${message}`;
    document.body.appendChild(div);
    
    setTimeout(() => {
        if (div && div.remove) {
            div.style.animation = 'fadeOutDown 0.2s ease';
            setTimeout(() => div.remove(), 200);
        }
    }, 2000);
}

function showAlert(message, type = 'info') {
    const types = { info: 'alert-info', success: 'alert-success', warning: 'alert-warning', danger: 'alert-danger' };
    const existing = document.querySelector('.global-alert');
    if (existing) existing.remove();
    const div = document.createElement('div');
    div.className = `alert ${types[type]} alert-dismissible fade show global-alert`;
    div.style.cssText = 'z-index:1060;animation:slideDown 0.3s ease;position:fixed;top:10px;left:50%;transform:translateX(-50%);min-width:300px;max-width:90%;';
    div.innerHTML = `<div class="d-flex align-items-center"><div class="flex-grow-1">${message}</div><button type="button" class="btn-close ms-2" data-bs-dismiss="alert"></button></div>`;
    document.body.appendChild(div);
    setTimeout(() => div.remove(), type === 'danger' ? 8000 : 5000);
}

function saveLogin(username, password, remember) {
    if (remember) {
        localStorage.setItem(STORAGE_KEYS.REMEMBER_ME, 'true');
        localStorage.setItem(STORAGE_KEYS.SAVED_USERNAME, username);
        localStorage.setItem(STORAGE_KEYS.SAVED_PASSWORD, password);
    } else {
        clearSavedLogin();
    }
}

function clearSavedLogin() {
    localStorage.removeItem(STORAGE_KEYS.REMEMBER_ME);
    localStorage.removeItem(STORAGE_KEYS.SAVED_USERNAME);
    localStorage.removeItem(STORAGE_KEYS.SAVED_PASSWORD);
}

function loadSavedUsername() {
    const rememberMe = localStorage.getItem(STORAGE_KEYS.REMEMBER_ME) === 'true';
    if (rememberMe) {
        const savedUsername = localStorage.getItem(STORAGE_KEYS.SAVED_USERNAME);
        if (savedUsername) {
            const usernameInput = document.getElementById('loginUsername');
            if (usernameInput) usernameInput.value = savedUsername;
            const rememberCheckbox = document.getElementById('rememberMe');
            if (rememberCheckbox) rememberCheckbox.checked = true;
            
            const passwordInput = document.getElementById('loginPassword');
            if (passwordInput && localStorage.getItem(STORAGE_KEYS.SAVED_PASSWORD)) {
                passwordInput.value = localStorage.getItem(STORAGE_KEYS.SAVED_PASSWORD);
            }
        }
    }
}

async function tryAutoLogin() {
    const rememberMe = localStorage.getItem(STORAGE_KEYS.REMEMBER_ME) === 'true';
    if (!rememberMe) return false;
    
    const savedUsername = localStorage.getItem(STORAGE_KEYS.SAVED_USERNAME);
    const savedPassword = localStorage.getItem(STORAGE_KEYS.SAVED_PASSWORD);
    
    if (!savedUsername || !savedPassword) return false;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ username: savedUsername, password: savedPassword })
        });
        
        const result = await response.json();
        
        if (response.ok && result.success) {
            showMainApp(result.user);
            return true;
        } else {
            clearSavedLogin();
            return false;
        }
    } catch (error) {
        return false;
    }
}

window.cancelAutoSave = function() {
    cancelAutoSaveFlag = true;
    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }
    const timerDiv = document.getElementById('autoSaveTimer');
    if (timerDiv) timerDiv.style.display = 'none';
    showAlert('已取消自动保存，请手动点击保存按钮', 'info');
};

function startAutoSaveTimer() {
    if (autoSaveTimer) {
        clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }
    
    cancelAutoSaveFlag = false;
    let seconds = 3;
    const timerDiv = document.getElementById('autoSaveTimer');
    const secondsSpan = document.getElementById('timerSeconds');
    
    if (!timerDiv || !secondsSpan) return;
    
    timerDiv.style.display = 'block';
    secondsSpan.textContent = seconds;
    
    function countdown() {
        if (cancelAutoSaveFlag) {
            if (autoSaveTimer) {
                clearTimeout(autoSaveTimer);
                autoSaveTimer = null;
            }
            return;
        }
        seconds--;
        if (seconds >= 0) {
            secondsSpan.textContent = seconds;
            autoSaveTimer = setTimeout(countdown, 1000);
        } else {
            timerDiv.style.display = 'none';
            saveProductRecord(false);
        }
    }
    countdown();
}

// 查询商品并显示已有日期
async function lookupProductWithExistingDates() {
    const sku = skuInput.value.trim();
    if (sku.length !== 5) return;

    try {
        // 查询商品信息
        const response = await apiRequest(`/api/products/${sku}`, 'GET');
        const product = response.data;

        if (product) {
            // 填充表单
            productName.value = product.name || '';
            shelfLife.value = product.shelf_life || '';
            reminderDays.value = product.reminder_days || '';
            productCategory.value = product.category || '其他类';
            
            // 设置生产日期为当天
            const today = new Date();
            const year = today.getFullYear();
            const month = String(today.getMonth() + 1).padStart(2, '0');
            const day = String(today.getDate()).padStart(2, '0');
            const todayStr = `${year}-${month}-${day}`;
            productionDate.value = todayStr;
            
            // 计算并显示到期日期
            calculateDates();
            
            // 显示已有日期
            showExistingDates();
            
            // 聚焦到生产日期输入框
            productionDate.focus();
            
            // 在移动端打开日期选择器
            if (window.innerWidth <= 768 && productionDate.type === 'date') {
                productionDate.showPicker();
            }
        } else {
            showAlert('未找到该SKU对应的商品', 'warning');
        }
    } catch (error) {
        if (error.message.includes('404')) {
            showAlert('未找到该SKU对应的商品', 'warning');
        } else {
            showAlert(`查询失败: ${error.message}`, 'danger');
        }
    }
}

async function saveProductRecord(isManualSave) {
    const sku = skuInput.value.trim();
    const name = productName.value.trim();
    const shelf_life = shelfLife.value.trim();
    const reminder_days = reminderDays.value.trim();
    const category = productCategory.value;
    const production_date = productionDate.value;
    const location = locationInput ? locationInput.value.trim() : '';

    if (!sku || !name || !shelf_life || !reminder_days || !production_date) {
        showAlert('请填写所有必填字段', 'warning');
        return;
    }

    try {
        const response = await apiRequest('/api/records', 'POST', {
            sku,
            name,
            shelf_life: parseInt(shelf_life),
            reminder_days: parseInt(reminder_days),
            category,
            production_date,
            location
        });

        if (isManualSave) {
            showQuickToast('保存成功', 'success');
        } else {
            // 自动保存可以不显示提示，或者显示一个短暂的提示
            showQuickToast('已自动保存', 'success');
        }
    } catch (error) {
        showAlert(`保存失败: ${error.message}`, 'danger');
    }
}
async function showExistingDates() {
    const sku = skuInput.value.trim();
    const currentDate = productionDate.value;
    if (!sku || sku.length !== 5 || !currentDate) return;
    
    try {
        // 强制刷新，避免缓存问题
        const records = await apiRequest(`/api/records/by-sku/${sku}?t=${Date.now()}`);
        if (records && records.length > 0) {
            const otherDates = records.filter(r => r.production_date !== currentDate).map(r => r.production_date);
            const hintDiv = document.getElementById('existingDateHint');
            if (otherDates.length > 0 && hintDiv) {
                hintDiv.innerHTML = `<i class="bi bi-info-circle"></i> 该商品已有生产日期: ${otherDates.join(', ')}`;
                hintDiv.style.display = 'block';
                // 延长显示时间，让用户有足够时间查看
                setTimeout(() => { 
                    if (hintDiv) hintDiv.style.display = 'none'; 
                }, 5000);
            } else if (hintDiv) {
                hintDiv.style.display = 'none';
            }
        } else {
            // 如果没有记录，也隐藏提示
            const hintDiv = document.getElementById('existingDateHint');
            if (hintDiv) hintDiv.style.display = 'none';
        }
    } catch(e) {
        // 出错时也隐藏提示
        const hintDiv = document.getElementById('existingDateHint');
        if (hintDiv) hintDiv.style.display = 'none';
    }
}

async function startScanner(callback) {
    currentScanCallback = callback;
    try {
        if (html5QrCode) {
            try { await html5QrCode.stop(); } catch(e) {}
        }
        html5QrCode = new Html5Qrcode("qr-reader");
        await html5QrCode.start(
            { facingMode: "environment" },
            { fps: 20, qrbox: { width: 250, height: 250 }, aspectRatio: 1.0, showTorchButtonIfSupported: true },
            (decodedText) => {
                if (currentScanCallback) currentScanCallback(decodedText);
                stopScanner();
                if (scannerModal) scannerModal.hide();
            },
            (errorMessage) => { console.log("扫码中:", errorMessage); }
        );
    } catch (err) {
        console.error("启动扫码失败:", err);
        showAlert("无法启动摄像头，请检查权限设置", "danger");
    }
}

function stopScanner() {
    if (html5QrCode) { html5QrCode.stop().catch(e => console.log(e)); html5QrCode = null; }
}

function extractLast5Digits(barcode) {
    const numbers = barcode.replace(/[^0-9]/g, '');
    return numbers.length >= 5 ? numbers.slice(-5) : numbers.padStart(5, '0');
}

// 防抖变量
let scanDebounceTimer = null;

function handleScanResult(targetInput, scannedValue) {
    // 防止重复快速触发
    if (scanDebounceTimer) {
        clearTimeout(scanDebounceTimer);
    }
    
    scanDebounceTimer = setTimeout(() => {
        // 如果是库位输入框，则按A1-01-01格式处理
        if (targetInput.id === 'newLocation' || targetInput.id === 'productLocation') {
            // 尝试匹配类似A1-01-01的格式，如果匹配不到则使用原值
            let processedValue = scannedValue;
            if (scannedValue.length >= 6) {
                // 提取字母和数字部分并格式化为 A1-01-01 格式
                const match = scannedValue.match(/^([A-Za-z])(\d{1,2})[-_]?(\d{1,2})[-_]?(\d{1,2})$/);
                if (match) {
                    processedValue = `${match[1]}${match[2]}-${match[3].padStart(2, '0')}-${match[4].padStart(2, '0')}`;
                } else {
                    // 如果不是标准格式，尝试构造 A1-01-01 格式
                    const digits = scannedValue.replace(/[^A-Za-z0-9]/g, '');
                    if (digits.length >= 5) {
                        const letter = digits.charAt(0).toUpperCase();
                        const numPart = digits.substring(1);
                        if (numPart.length >= 4) {
                            processedValue = `${letter}${numPart.charAt(0)}-${numPart.charAt(1)}${numPart.charAt(2)}-${numPart.charAt(3)}${numPart.charAt(4) || '0'}`;
                        } else {
                            processedValue = `${letter}${numPart}`;
                        }
                    }
                }
            }
            targetInput.value = processedValue;
            showQuickToast(`已识别库位条形码: ${processedValue}`, "success");
        } else {
            // 对于SKU输入框，仍然使用原来的5位数字处理
            const last5 = extractLast5Digits(scannedValue);
            targetInput.value = last5;
            showQuickToast(`已识别条形码，提取后5位: ${last5}`, "success");
        }
        
        const event = new Event('input', { bubbles: true });
        targetInput.dispatchEvent(event);
        
        if (targetInput.id === 'skuInput') {
            // 上面的 dispatchEvent('input') 已触发 skuInput 的 input 监听器，
            // 由监听器统一调用 lookupProductWithExistingDates()。
            // 此处不再重复调用 lookup，也不再额外 focus()/click()，
            // 避免生产日期被多次写入、日期选择器被反复 toggle 而弹不出来。
        }
        if (targetInput.id === 'searchSku') setTimeout(() => searchProduct(), 150); // 减少延迟
        
        scanDebounceTimer = null;
    }, 200); // 减少防抖延迟以提高响应速度
}

function setupImageUpload() {
    if (!imageUploadArea) return;
    
    imageUploadArea.addEventListener('click', (e) => {
        e.stopPropagation();
        if (productImageInput) {
            productImageInput.click();
        }
    });
    
    imageUploadArea.addEventListener('dragover', (e) => { 
        e.preventDefault(); 
        imageUploadArea.classList.add('drag-over'); 
    });
    imageUploadArea.addEventListener('dragleave', () => { 
        imageUploadArea.classList.remove('drag-over'); 
    });
    imageUploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        imageUploadArea.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith('image/')) handleImageFile(file);
    });
    
    if (productImageInput) {
        productImageInput.addEventListener('change', (e) => { 
            if (e.target.files && e.target.files[0]) {
                handleImageFile(e.target.files[0]);
            }
        });
    }
    
    if (removeImageBtn) {
        removeImageBtn.addEventListener('click', () => { 
            currentImageData = null; 
            currentImageMime = null; 
            if (imagePreviewContainer) imagePreviewContainer.innerHTML = ''; 
            removeImageBtn.style.display = 'none'; 
            showQuickToast('图片已删除', 'info');
            if (productImageInput) productImageInput.value = '';
        });
    }

    // 绑定相机拍照按钮
    const cameraCaptureBtn = document.getElementById('cameraCaptureBtn');
    if (cameraCaptureBtn) {
        cameraCaptureBtn.addEventListener('click', capturePhotoWithCamera);
    }
}

// 图片压缩函数
function compressImage(imageData, mimeType, quality = 0.7, maxWidth = 800, maxHeight = 800) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = function() {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;

            // 计算缩放比例
            if (width > maxWidth || height > maxHeight) {
                const scale = Math.min(maxWidth / width, maxHeight / height);
                width = Math.floor(width * scale);
                height = Math.floor(height * scale);
            }

            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            // 转换为压缩后的数据URL
            const compressedDataUrl = canvas.toDataURL(mimeType, quality);
            resolve(compressedDataUrl);
        };
        img.onerror = reject;
        img.src = imageData;
    });
}

// 处理压缩后的图片
async function handleCompressedImage(compressedDataUrl, originalMimeType) {
    currentImageData = compressedDataUrl;
    currentImageMime = originalMimeType;
    
    if (imagePreviewContainer) {
        // 显示压缩后的图片
        imagePreviewContainer.innerHTML = `<img src="${compressedDataUrl}" class="image-preview" alt="预览"><small class="d-block mt-1">已压缩图片</small>`;
    }
    if (removeImageBtn) removeImageBtn.style.display = 'inline-block';
    showQuickToast('图片已压缩并上传', 'success');
}

function handleImageFile(file) {
    if (file.size > 5 * 1024 * 1024) { 
        showAlert('图片大小不能超过5MB', 'warning'); 
        return; 
    }
    const reader = new FileReader();
    reader.onload = async function(e) {
        const originalData = e.target.result;
        const originalMime = file.type;
        
        try {
            // 对图片进行压缩
            const compressedData = await compressImage(originalData, originalMime);
            await handleCompressedImage(compressedData, originalMime);
        } catch (error) {
            console.error('图片压缩失败:', error);
            // 如果压缩失败，使用原图
            currentImageData = originalData;
            currentImageMime = originalMime;
            if (imagePreviewContainer) {
                imagePreviewContainer.innerHTML = `<img src="${originalData}" class="image-preview" alt="预览"><small class="d-block mt-1">${file.name} (${(file.size/1024).toFixed(1)} KB)</small>`;
            }
            if (removeImageBtn) removeImageBtn.style.display = 'inline-block';
            showQuickToast('图片已上传', 'success');
        }
	};
	reader.readAsDataURL(file);
	}
	
	// 将图片数据转换为Blob对象（用于按SKU重命名文件）
	function dataURLToBlob(dataURL) {
	    const arr = dataURL.split(',');
	    const mime = arr[0].match(/:(.*?);/)[1];
	    const bstr = atob(arr[1]);
	    let n = bstr.length;
	    const u8arr = new Uint8Array(n);
	    while (n--) {
	        u8arr[n] = bstr.charCodeAt(n);
	    }
	    return new Blob([u8arr], { type: mime });
	}
	
	// 调用相机拍照
async function capturePhotoWithCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showAlert('您的设备不支持相机功能', 'warning');
        return;
    }

    try {
        // 请求相机权限
        const stream = await navigator.mediaDevices.getUserMedia({ 
            video: { 
                facingMode: 'environment', // 优先使用后置摄像头
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            } 
        });

        // 创建相机预览界面
        const cameraModal = document.createElement('div');
        cameraModal.className = 'modal fade show d-block';
        cameraModal.style.backgroundColor = 'rgba(0,0,0,0.8)';
        cameraModal.innerHTML = `
            <div class="modal-dialog modal-dialog-centered">
                <div class="modal-content">
                    <div class="modal-header">
                        <h5 class="modal-title">拍照上传</h5>
                        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                    </div>
                    <div class="modal-body text-center">
                        <video id="cameraPreview" autoplay playsinline style="max-width: 100%; max-height: 400px;"></video>
                        <div class="mt-3">
                            <button class="btn btn-success me-2" id="takePhotoBtn">
                                <i class="bi bi-camera-fill"></i> 拍照
                            </button>
                            <button class="btn btn-secondary" id="cancelCameraBtn">
                                <i class="bi bi-x-circle"></i> 取消
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(cameraModal);

        const video = document.getElementById('cameraPreview');
        video.srcObject = stream;

        // 绑定拍照按钮事件
        document.getElementById('takePhotoBtn').addEventListener('click', function() {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            
            // 停止视频流
            stream.getTracks().forEach(track => track.stop());
            
            // 关闭相机界面
            cameraModal.remove();
            
            // 压缩并处理照片
            const photoDataUrl = canvas.toDataURL('image/jpeg');
            handleCompressedImage(photoDataUrl, 'image/jpeg');
        });

        // 绑定取消按钮事件
        document.getElementById('cancelCameraBtn').addEventListener('click', function() {
            stream.getTracks().forEach(track => track.stop());
            cameraModal.remove();
        });

    } catch (error) {
        console.error('相机访问错误:', error);
        if (error.name === 'NotAllowedError') {
            showAlert('相机权限被拒绝，请允许访问相机后重试', 'warning');
        } else if (error.name === 'NotFoundError') {
            showAlert('未找到可用的相机设备', 'warning');
        } else {
            showAlert('相机访问失败: ' + error.message, 'danger');
        }
    }
}

async function loadProductImage(sku) {
    hadExistingImage = false;
    try {
        const response = await fetch(`${API_BASE_URL}/api/images/${sku}`, { credentials: 'include' });
        if (response.ok) {
            const data = await response.json();
            if (data && data.image_data) {
                hadExistingImage = true;
                currentImageData = data.image_data;
                currentImageMime = data.image_mime;
                if (imagePreviewContainer) {
                    imagePreviewContainer.innerHTML = `<img src="${currentImageData}" class="image-preview" alt="商品图片">`;
                }
                if (removeImageBtn) removeImageBtn.style.display = 'inline-block';
                return true;
            }
        }
    } catch (error) { 
        console.log('加载图片失败:', error); 
    }
    return false;
}

async function saveProductImage(sku) {
    if (currentImageData) {
        try {
            // 后端 POST /api/images/:sku 期望 JSON {imageData, imageMime}，
            // 原实现用 FormData 上传，express.json 不解析 multipart，
            // 导致 imageData 为 undefined、图片实际未落库（"假成功"）。
            // 这里改为 JSON 提交，字段与后端严格对齐。
            await apiRequest(`/api/images/${encodeURIComponent(sku)}`, 'POST', {
                imageData: currentImageData,
                imageMime: currentImageMime
            });
            return true;
        } catch (error) {
            console.error('保存图片失败:', error);
        }
    }
    return false;
}

async function deleteProductImage(sku) {
    try {
        await apiRequest(`/api/images/${sku}`, 'DELETE');
        currentImageData = null;
        currentImageMime = null;
        if (imagePreviewContainer) imagePreviewContainer.innerHTML = '';
        if (removeImageBtn) removeImageBtn.style.display = 'none';
        return true;
    } catch (error) { 
        console.error('删除图片失败:', error); 
        return false;
    }
}

function showImagePreview(imageUrl) {
    const previewImage = document.getElementById('previewImage');
    if (previewImage) previewImage.src = imageUrl;
    if (imagePreviewModal) imagePreviewModal.show();
}

// 统一的图片缓存管理器
class ImageCacheManager {
    constructor() {
        this.cache = new Map();
        this.loadingPromises = new Map();
    }

    async getImageUrl(sku) {
        // 如果缓存中有，直接返回
        if (this.cache.has(sku)) {
            return this.cache.get(sku);
        }

        // 如果正在加载，返回相同的Promise
        if (this.loadingPromises.has(sku)) {
            return this.loadingPromises.get(sku);
        }

        // 开始加载
        const loadingPromise = this.loadImage(sku);
        this.loadingPromises.set(sku, loadingPromise);

        try {
            const result = await loadingPromise;
            if (result) {
                this.cache.set(sku, result);
            }
            return result;
        } finally {
            this.loadingPromises.delete(sku);
        }
    }

    async loadImage(sku) {
        try {
            const response = await fetch(`${API_BASE_URL}/api/images/${sku}`, { credentials: 'include' });
            if (response.ok) {
                const data = await response.json();
                if (data && data.image_data) {
                    return data.image_data;
                }
            }
        } catch (error) {
            console.log(`加载商品 ${sku} 图片失败:`, error);
        }
        return null;
    }

    getFallbackUrl(sku) {
        return `/api/images/${encodeURIComponent(sku)}`;
    }

    clear() {
        this.cache.clear();
        this.loadingPromises.clear();
    }
}

// 创建全局图片缓存管理器实例
const imageCacheManager = new ImageCacheManager();

async function getProductImageUrl(sku) {
    return imageCacheManager.getImageUrl(sku);
}

async function apiRequest(endpoint, method = 'GET', data = null, timeout = 30000) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    
    const options = { 
        method, 
        headers: { 'Content-Type': 'application/json' }, 
        credentials: 'include',
        signal: controller.signal
    };
    if (data) options.body = JSON.stringify(data);
    
    try {
        const response = await fetch(`${API_BASE_URL}${endpoint}`, options);
        clearTimeout(timeoutId);
        
        if (response.status === 401) { 
            await checkAuth(true); 
            throw new Error('未授权'); 
        }
        if (response.status === 204) return null;
        const responseText = await response.text();
        let result = responseText ? JSON.parse(responseText) : null;

        if (!response.ok) throw new Error(result?.error || `请求失败（HTTP ${response.status}），请稍后重试`);
        return result;
    } catch (error) {
        clearTimeout(timeoutId);
        console.error('API请求错误:', error);
	        if (error.name === 'AbortError') {
	            throw new Error('请求超时，请检查网络');
	        }
	        if (error instanceof TypeError || /failed to fetch|networkerror|load failed|network request failed/i.test(error.message)) {
	            error = new Error('网络连接失败，请检查网络后重试');
	        }
	        if (error.message !== '未授权') showAlert(`请求失败: ${error.message}`, 'danger');
	        throw error;
    }
}

async function getProductLocation(sku) {
    try {
        const product = await apiRequest(`/api/products/${sku}`);
        return product?.location || null;
    } catch (error) { return null; }
}

function startAuthChecker() { 
    if (authCheckerInterval) clearInterval(authCheckerInterval);
    authCheckerInterval = setInterval(() => checkAuth(), AUTH_CHECK_INTERVAL); 
}

function stopAuthChecker() {
    if (authCheckerInterval) {
        clearInterval(authCheckerInterval);
        authCheckerInterval = null;
    }
}

async function checkAuth(force = false) {
    const now = Date.now();
    if (!force && (now - lastAuthCheck) < 30000) return true;
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/check`, { 
            credentials: 'include',
            cache: 'no-store'
        });
        const result = await response.json();
        lastAuthCheck = now;
        
        if (result.isLoggedIn) {
            isShowingLoginAlert = false;
            currentUserRole = result.user?.role;
            showMainApp(result.user);
            if (result.user?.expiryWarning) {
                expiryWarningText.textContent = result.user.expiryWarning;
                expiryWarningBar.style.display = 'block';
                if (result.user.expiryWarning.includes('已过期')) expiryWarningBar.classList.add('expiry-danger-bar');
            } else {
                expiryWarningBar.style.display = 'none';
                expiryWarningBar.classList.remove('expiry-danger-bar');
            }
            const adminTabLi = document.getElementById('admin-tab-li');
            if (adminTabLi) adminTabLi.style.display = (result.user?.role === 'admin') ? 'block' : 'none';
            return true;
        } else {
            const autoLoggedIn = await tryAutoLogin();
            if (autoLoggedIn) return true;
            
            if (!isShowingLoginAlert && force) {
                isShowingLoginAlert = true;
                showAlert('登录已过期，请重新登录', 'warning');
            }
            showLogin();
            return false;
        }
    } catch (error) { 
        showLogin(); 
        return false; 
    }
}

function showLogin() {
    if (loginContainer) loginContainer.classList.remove('d-none');
    if (mainApp) mainApp.classList.add('d-none');
    currentUserRole = null;
    isShowingLoginAlert = false;
}

function showMainApp(user) {
    if (loginContainer) loginContainer.classList.add('d-none');
    if (mainApp) mainApp.classList.remove('d-none');
    if (currentUsername) currentUsername.textContent = user.username;
	    
    // 更新侧边栏用户名
    const sidebarUsername = document.getElementById('sidebar-username');
    if (sidebarUsername) sidebarUsername.textContent = user.username;
	    
    currentUserRole = user.role;
	    
    // 根据用户角色控制管理员功能的显示
    const adminTabLi = document.getElementById('admin-tab-li');
    if (adminTabLi) {
        adminTabLi.style.display = (user?.role === 'admin') ? 'block' : 'none';
    }
	    
    // 控制移动端侧边栏中的系统管理按钮显示
    const adminSidebarItems = document.querySelectorAll('.sidebar-menu-item[data-target="admin"]');
    adminSidebarItems.forEach(item => {
        item.style.display = (user?.role === 'admin') ? 'flex' : 'none';
    });
	    
    initMainApp();
    // 登录成功后延迟更新菜单数字，确保数据加载完成
    setTimeout(() => {
        updateMenuBadgeCounts();
    }, 500);
}

async function login() {
    const username = document.getElementById('loginUsername')?.value.trim();
    const password = document.getElementById('loginPassword')?.value.trim();
    const rememberMe = document.getElementById('rememberMe')?.checked || false;
    
    if (!username || !password) { 
        showAlert('请输入用户名和密码', 'warning'); 
        return; 
    }
    
    const loginBtnElem = document.getElementById('loginBtn');
    if (!loginBtnElem) {
        showAlert('登录按钮元素未找到，请刷新页面重试', 'danger');
        return;
    }
    const originalText = loginBtnElem.innerHTML;
    loginBtnElem.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 登录中...';
    loginBtnElem.disabled = true;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
            method: 'POST', 
            headers: { 'Content-Type': 'application/json' }, 
            credentials: 'include',
            body: JSON.stringify({ username, password })
        });
        
        const result = await response.json();
        
        if (!response.ok) throw new Error(result.error || '登录失败');
        
        saveLogin(username, password, rememberMe);
        
        showMainApp(result.user);
        showAlert('登录成功', 'success');
        
        const loginPassword = document.getElementById('loginPassword');
        if (loginPassword) loginPassword.value = '';
        
    } catch (error) { 
        showAlert(`登录失败: ${error.message}`, 'danger');
        clearSavedLogin();
    } finally {
        if (loginBtnElem) {
            loginBtnElem.innerHTML = originalText;
            loginBtnElem.disabled = false;
        }
    }
}

async function register() {
    const username = document.getElementById('registerUsername')?.value.trim();
    const password = document.getElementById('registerPassword')?.value.trim();
    const confirm = document.getElementById('registerConfirmPassword')?.value.trim();
    const authCode = document.getElementById('registerAuthCode')?.value.trim();
    
    if (!username || !password) { showAlert('用户名和密码不能为空', 'warning'); return; }
    if (username.length < 3 || username.length > 20) { showAlert('用户名长度应在3-20字符之间', 'warning'); return; }
    if (password.length < 6) { showAlert('密码长度不能少于6位', 'warning'); return; }
    if (password !== confirm) { showAlert('两次输入的密码不一致', 'warning'); return; }
    if (!authCode) { showAlert('请输入授权码', 'warning'); return; }
    if (authCode.length !== 8) { showAlert('授权码应为8位', 'warning'); return; }
    
    const btn = document.getElementById('registerBtn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 注册中...';
    btn.disabled = true;
    
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, email: '', authCode })
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || '注册失败');
        showAlert('注册成功，请登录', 'success');
        document.getElementById('registerUsername').value = '';
        document.getElementById('registerPassword').value = '';
        document.getElementById('registerConfirmPassword').value = '';
        document.getElementById('registerAuthCode').value = '';
        const loginTab = document.getElementById('login-tab');
        if (loginTab) loginTab.click();
        document.getElementById('loginUsername').value = username;
        document.getElementById('loginPassword').focus();
    } catch (error) {
        let msg = error.message;
        if (msg.includes('授权码')) msg = '授权码无效或已过期';
        if (msg.includes('用户名已存在')) msg = '该用户名已被注册';
        showAlert(`注册失败: ${msg}`, 'danger');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
}

async function logout() {
    try {
        await fetch(`${API_BASE_URL}/api/auth/logout`, { method: 'POST', credentials: 'include' });
        dataCache.clear();
        stopAuthChecker();
        
        // 清理本地存储的出清相关数据，防止跨设备显示之前操作的数据
        localStorage.removeItem('clearanceIgnoreList');
        localStorage.removeItem('recentClearanceList');
        
        showLogin();
        showAlert('已成功登出', 'info');
    } catch (error) { 
        stopAuthChecker();
        showLogin(); 
    }
}

function addLogoutAndClearBtn() {
    const logoutButton = document.getElementById('logoutBtn');
    if (!logoutButton) return;
    
    logoutButton.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (confirm('是否清除所有保存的登录信息？')) {
            clearSavedLogin();
            showAlert('已清除保存的登录信息', 'info');
        }
    });
}

async function performSwipeDelete(item, cardElement) {
    const now = Date.now();
    if (now - lastDeleteTime < DELETE_THROTTLE_MS) {
        if (cardElement) {
            cardElement.classList.remove('swiping');
            const inner = cardElement.querySelector('.card-inner');
            if (inner) {
                inner.style.transform = '';
                inner.style.transition = '';
            }
        }
        return;
    }
    lastDeleteTime = now;
    
    // 保存到最近删除
    addToDeletedItems(item);
    
    if (cardElement) {
        cardElement.classList.remove('swiping');
        cardElement.classList.add('delete-animate');
        
        await new Promise(resolve => {
            if (animationTimeout) clearTimeout(animationTimeout);
            animationTimeout = setTimeout(resolve, 250);
        });
        
        if (cardElement.remove) {
            cardElement.remove();
        }
    }
    
    try {
        await apiRequest(`/api/records/${item.sku}/${item.production_date}`, 'DELETE');
        
        if (dataCache.records) {
            const newRecords = dataCache.records.filter(r => 
                !(r.sku === item.sku && r.production_date === item.production_date)
            );
            dataCache.records = newRecords;
            dataCache.expiring = newRecords.filter(r => {
                const remaining = calculateRemainingDaysLocal(r.production_date, r.shelf_life);
                return remaining <= (r.reminder_days || 0);
            });
            dataCache.lastFetch.records = Date.now();
            dataCache.lastFetch.expiring = Date.now();
        }
        
        // 删除后如果当前正在编辑相同SKU，更新已有日期显示
        if (skuInput && skuInput.value.trim() === item.sku) {
            setTimeout(() => {
                showExistingDates();
            }, 500);
        }
        
        const rowsToRemove = document.querySelectorAll(`#expiringTable tr[data-swipe-sku="${item.sku}"][data-swipe-date="${item.production_date}"], #allTable tr[data-swipe-sku="${item.sku}"][data-swipe-date="${item.production_date}"]`);
        rowsToRemove.forEach(row => {
            if (row.isConnected) {
                row.classList.add('delete-animate');
                setTimeout(() => { if (row.remove) row.remove(); }, 250);
            }
        });
        
        await updateExpiryCount();
        await updateExpiryWarning();
        
        showQuickToast(`已下架: ${item.name}`, 'success');
        
    } catch (error) {
        console.error('删除失败:', error);
        showQuickToast(`删除失败: ${error.message}`, 'danger');
        await renderExpiringTable(true);
        await renderAllTable(true);
    } finally {
        if (animationTimeout) clearTimeout(animationTimeout);
        animationTimeout = null;
    }
}

function initSwipeToDelete() {
    if (window.innerWidth > 768) return;
    
    const cardsContainer = document.getElementById('expiringCards');
    const allCardsContainer = document.getElementById('allCards');
    
    const setupSwipeForContainer = (container) => {
        if (!container) return;
        
        let localTouchStartX = 0;
        let localTouchStartY = 0;
        let localTouchCard = null;
        let localTouchStartTime = 0;
        let isSwiping = false;
        
        container.addEventListener('touchstart', (e) => {
            const card = e.target.closest('.expiring-card');
            
            document.querySelectorAll('.expiring-card.swiping').forEach(c => {
                if (c !== card) {
                    c.classList.remove('swiping');
                    const inner = c.querySelector('.card-inner');
                    if (inner) {
                        inner.style.transform = '';
                        inner.style.transition = '';
                    }
                }
            });
            
            if (!card) return;
            
            localTouchStartX = e.touches[0].clientX;
            localTouchStartY = e.touches[0].clientY;
            localTouchCard = card;
            localTouchStartTime = Date.now();
            isSwiping = false;
            card.dataset.swiping = 'false';
            
            const inner = card.querySelector('.card-inner');
            if (inner) {
                inner.style.transition = 'transform 0.05s linear';
            }
        }, { passive: true });
        
        container.addEventListener('touchmove', (e) => {
            if (!localTouchCard) return;
            
            const deltaX = e.touches[0].clientX - localTouchStartX;
            const deltaY = e.touches[0].clientY - localTouchStartY;
            
            if (Math.abs(deltaX) > Math.abs(deltaY) && deltaX < 0) {
                e.preventDefault();
                isSwiping = true;
                const inner = localTouchCard.querySelector('.card-inner');
                if (inner) {
                    const translateX = Math.max(-60, deltaX);
                    inner.style.transform = `translateX(${translateX}px)`;
                    const opacity = Math.min(1, Math.abs(deltaX) / 40);
                    localTouchCard.style.setProperty('--delete-opacity', opacity);
                }
            } else if (Math.abs(deltaX) > Math.abs(deltaY) && deltaX > 15) {
                const inner = localTouchCard.querySelector('.card-inner');
                if (inner) {
                    inner.style.transform = '';
                    inner.style.transition = 'transform 0.15s ease-out';
                }
                localTouchCard.classList.remove('swiping');
                localTouchCard = null;
            }
        }, { passive: false });
        
        container.addEventListener('touchend', (e) => {
            if (!localTouchCard) {
                document.querySelectorAll('.expiring-card.swiping').forEach(c => {
                    c.classList.remove('swiping');
                    const inner = c.querySelector('.card-inner');
                    if (inner) {
                        inner.style.transform = '';
                        inner.style.transition = '';
                    }
                });
                return;
            }
            
            const deltaX = e.changedTouches[0].clientX - localTouchStartX;
            const deltaTime = Date.now() - localTouchStartTime;
            const inner = localTouchCard.querySelector('.card-inner');
            
            if (isSwiping && deltaX < -50 && deltaTime < 300) {
                const deleteBtn = localTouchCard.querySelector('.delete-record-btn');
                if (deleteBtn) {
                    const sku = deleteBtn.getAttribute('data-sku');
                    const productionDateVal = deleteBtn.getAttribute('data-production-date');
                    const name = deleteBtn.getAttribute('data-name');
                    const shelfLifeVal = parseInt(deleteBtn.getAttribute('data-shelf-life') || 0);
                    const reminderDaysVal = parseInt(deleteBtn.getAttribute('data-reminder-days') || 0);
                    const location = deleteBtn.getAttribute('data-location');
                    const category = deleteBtn.getAttribute('data-category') || '其他类';
                    
                    const item = {
                        sku: sku,
                        name: name,
                        production_date: productionDateVal,
                        shelf_life: shelfLifeVal,
                        reminder_days: reminderDaysVal,
                        location: location,
                        category: category
                    };
                    
                    if (inner) {
                        inner.style.transform = '';
                        inner.style.transition = '';
                    }
                    localTouchCard.classList.remove('swiping');
                    performSwipeDelete(item, localTouchCard);
                }
            } else {
                if (inner) {
                    inner.style.transform = '';
                    inner.style.transition = 'transform 0.2s ease-out';
                    setTimeout(() => {
                        if (inner) inner.style.transition = '';
                    }, 200);
                }
                localTouchCard.classList.remove('swiping');
            }
            
            localTouchCard = null;
            isSwiping = false;
        });
    };
    
    setupSwipeForContainer(cardsContainer);
    setupSwipeForContainer(allCardsContainer);
}

async function deleteWithAnimation(item, elements, type) {
    if (elements && elements.length > 0) {
        elements.forEach(el => {
            if (el && el.classList) {
                el.classList.add('delete-animate');
            }
        });
        
        await new Promise(resolve => {
            if (animationTimeout) clearTimeout(animationTimeout);
            animationTimeout = setTimeout(resolve, 250);
        });
        
        elements.forEach(el => {
            if (el && el.remove) {
                el.remove();
            }
        });
    }
    
    try {
        if (type === 'record') {
            // 保存到最近删除
            addToDeletedItems(item);
            
            await apiRequest(`/api/records/${item.sku}/${item.production_date}`, 'DELETE');
            
            if (dataCache.records) {
                const newRecords = dataCache.records.filter(r => 
                    !(r.sku === item.sku && r.production_date === item.production_date)
                );
                dataCache.records = newRecords;
                dataCache.expiring = newRecords.filter(r => {
                    const remaining = calculateRemainingDaysLocal(r.production_date, r.shelf_life);
                    return remaining <= (r.reminder_days || 0);
                });
                dataCache.lastFetch.records = Date.now();
                dataCache.lastFetch.expiring = Date.now();
            }
            
            // 删除后如果当前正在编辑相同SKU，更新已有日期显示
            if (skuInput && skuInput.value.trim() === item.sku) {
                setTimeout(() => {
                    showExistingDates();
                }, 500);
            }
            
            const rowsToRemove = document.querySelectorAll(`#expiringTable tr[data-swipe-sku="${item.sku}"][data-swipe-date="${item.production_date}"], #allTable tr[data-swipe-sku="${item.sku}"][data-swipe-date="${item.production_date}"]`);
            rowsToRemove.forEach(row => {
                if (row.isConnected) {
                    row.classList.add('delete-animate');
                    setTimeout(() => { if (row.remove) row.remove(); }, 250);
                }
            });
            
            await updateExpiryCount();
            await updateExpiryWarning();
            showQuickToast('库存记录已删除', 'success');
            
        } else if (type === 'product') {
            await apiRequest(`/api/products/${item.sku}`, 'DELETE');
            showQuickToast('商品已从数据库删除', 'success');
            dataCache.clear();
            await renderProductDatabaseTable(true);
            
            if (dataCache.records) {
                const newRecords = dataCache.records.filter(r => r.sku !== item.sku);
                dataCache.records = newRecords;
                dataCache.expiring = newRecords.filter(r => {
                    const remaining = calculateRemainingDaysLocal(r.production_date, r.shelf_life);
                    return remaining <= (r.reminder_days || 0);
                });
                dataCache.lastFetch.records = Date.now();
                dataCache.lastFetch.expiring = Date.now();
            }
            
            const rowsToRemove = document.querySelectorAll(`#expiringTable tr[data-swipe-sku="${item.sku}"], #allTable tr[data-swipe-sku="${item.sku}"]`);
            rowsToRemove.forEach(row => {
                if (row.isConnected) {
                    row.classList.add('delete-animate');
                    setTimeout(() => { if (row.remove) row.remove(); }, 250);
                }
            });
            
            const cardsToRemove = document.querySelectorAll(`.expiring-card .delete-record-btn[data-sku="${item.sku}"]`);
            cardsToRemove.forEach(btn => {
                const card = btn.closest('.expiring-card');
                if (card && card.isConnected) {
                    card.classList.add('delete-animate');
                    setTimeout(() => { if (card.remove) card.remove(); }, 250);
                }
            });
            
            await updateExpiryCount();
            await updateExpiryWarning();
        }
        
        return true;
    } catch (error) {
        console.error('删除失败:', error);
        showAlert(`删除失败: ${error.message}`, 'danger');
        return false;
    } finally {
        if (animationTimeout) clearTimeout(animationTimeout);
        animationTimeout = null;
    }
}

async function deleteItemWithAnimation() {
    const itemToDelete = currentSelectedItem;
    const typeToDelete = deleteType;
    const pendingElements = window._pendingDeleteElements;
    
    if (!itemToDelete) {
        if (confirmModal) confirmModal.hide();
        cleanupModalBackdrops();
        return;
    }
    
    if (confirmModal) {
        confirmModal.hide();
        await new Promise(resolve => setTimeout(resolve, 150));
        cleanupModalBackdrops();
    }
    
    const elementsToAnimate = [];
    if (pendingElements) {
        if (pendingElements.card && pendingElements.card.isConnected) elementsToAnimate.push(pendingElements.card);
        if (pendingElements.row && pendingElements.row.isConnected) elementsToAnimate.push(pendingElements.row);
    }
    
    if (elementsToAnimate.length === 0 && typeToDelete === 'record') {
        const allDeleteBtns = document.querySelectorAll(`.delete-record-btn[data-sku="${itemToDelete.sku}"][data-production-date="${itemToDelete.production_date}"]`);
        allDeleteBtns.forEach(btn => {
            const card = btn.closest('.expiring-card');
            const row = btn.closest('tr');
            if (card && card.isConnected) elementsToAnimate.push(card);
            if (row && row.isConnected) elementsToAnimate.push(row);
        });
    }
    
    const success = await deleteWithAnimation(itemToDelete, elementsToAnimate, typeToDelete);
    
    if (!success) {
        if (typeToDelete === 'record') {
            await renderExpiringTable(true);
            await renderAllTable(true);
        } else if (typeToDelete === 'product') {
            dataCache.clear();
            await renderExpiringTable(true);
            await renderAllTable(true);
            await renderProductDatabaseTable(true);
        }
    }
    
    currentSelectedItem = null;
    deleteType = '';
    window._pendingDelete = null;
    window._pendingDeleteElements = null;
}

function cleanupModalBackdrops() {
    const backdrops = document.querySelectorAll('.modal-backdrop');
    backdrops.forEach(backdrop => backdrop.remove());
    document.body.classList.remove('modal-open');
    document.body.style.overflow = '';
    document.body.style.paddingRight = '';
}

function showDeleteConfirm(item, type) {
    window._pendingDeleteElements = null;
    window._pendingDelete = null;
    
    currentSelectedItem = item;
    deleteType = type;
    
    const modalTitle = document.getElementById('modalTitle');
    const modalBodyElem = document.getElementById('modalBody');
    
    let expiryDateStr = '';
    let remainingDaysVal = 0;
    let statusBadge = '';
    
    if (type === 'record') {
        const expiryDateVal = new Date(createBJDate(item.production_date));
        expiryDateVal.setUTCDate(expiryDateVal.getUTCDate() + item.shelf_life);
        expiryDateStr = formatDateLocal(expiryDateVal);
        remainingDaysVal = calculateRemainingDaysLocal(item.production_date, item.shelf_life);
        
        if (remainingDaysVal <= 0) {
            statusBadge = '<span class="badge bg-danger">已过期</span>';
        } else if (remainingDaysVal <= (item.reminder_days || 0)) {
            statusBadge = '<span class="badge bg-warning text-dark">临期</span>';
        } else {
            statusBadge = '<span class="badge bg-success">正常</span>';
        }
        
        window._pendingDelete = {
            sku: item.sku,
            productionDate: item.production_date
        };
        
        let card = null, row = null;
        const expiringDeleteBtns = document.querySelectorAll(`#expiringTable .delete-record-btn[data-sku="${item.sku}"][data-production-date="${item.production_date}"]`);
        const allDeleteBtns = document.querySelectorAll(`#allTable .delete-record-btn[data-sku="${item.sku}"][data-production-date="${item.production_date}"]`);
        
        const allBtns = [...expiringDeleteBtns, ...allDeleteBtns];
        allBtns.forEach(btn => {
            if (!card) card = btn.closest('.expiring-card');
            if (!row) row = btn.closest('tr');
        });
        
        window._pendingDeleteElements = { card, row };
        
        if (modalTitle) modalTitle.textContent = '下架商品确认';
        if (modalBodyElem) {
            modalBodyElem.innerHTML = `<div class="alert alert-danger"><h5><i class="bi bi-exclamation-triangle"></i> 确定要下架这个商品吗？</h5><div class="border-top my-3"></div><table class="table table-borderless"><tr><td style="width:100px"><strong>商品名称：</strong></td><td><strong>${escapeHtml(item.name)}</strong></td></tr><tr><td><strong>SKU：</strong></td><td>${escapeHtml(item.sku)}</td></tr><tr><td><strong>生产日期：</strong></td><td>${item.production_date}</td></tr><tr><td><strong>到期日期：</strong></td><td>${expiryDateStr}</td></tr><tr><td><strong>分类：</strong></td><td>${escapeHtml(item.category || '其他类')}</td></tr><tr><td><strong>状态：</strong></td><td>${statusBadge}</td></tr></table><p class="text-danger mt-2"><i class="bi bi-info-circle"></i> 下架后无法恢复！</p></div>`;
        }
    } else if (type === 'product') {
        if (modalTitle) modalTitle.textContent = '删除商品确认';
        if (modalBodyElem) {
            modalBodyElem.innerHTML = `<div class="alert alert-danger"><h5><i class="bi bi-exclamation-triangle"></i> 确定要删除这个商品吗？</h5><div class="border-top my-3"></div><table class="table table-borderless"><tr><td style="width:100px"><strong>商品名称：</strong></td><td><strong>${escapeHtml(item.name)}</strong></td></tr><tr><td><strong>SKU：</strong></td><td>${escapeHtml(item.sku)}</td></tr><tr><td><strong>保质期：</strong></td><td>${item.shelf_life} 天</td></tr><tr><td><strong>分类：</strong></td><td>${escapeHtml(item.category || '其他类')}</td></tr><tr><td><strong>库位：</strong></td><td>${escapeHtml(item.location)}</td></tr></table><div class="alert alert-warning mt-2"><i class="bi bi-info-circle"></i> 删除后无法恢复，库存中已有的该商品记录不会自动删除。</div></div>`;
        }
    }
    
    const confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    if (confirmDeleteBtn) {
        const newBtn = confirmDeleteBtn.cloneNode(true);
        confirmDeleteBtn.parentNode.replaceChild(newBtn, confirmDeleteBtn);
        newBtn.addEventListener('click', function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (confirmModal) {
                confirmModal.hide();
            }
            setTimeout(() => {
                deleteItemWithAnimation();
            }, 100);
        });
    }
    
    if (confirmModal) confirmModal.show();
}

function showEditModal(product) {
    const addTab = document.getElementById('add-tab');
    if (addTab) {
        const tabTrigger = new bootstrap.Tab(addTab);
        tabTrigger.show();
    }
    
    setTimeout(() => {
        if (searchSku) searchSku.value = product.sku;
        if (searchBtn) searchBtn.click();
    }, 100);
}

function bindDeleteButtons() {
    const containers = ['expiringTable', 'allTable', 'expiringCards', 'allCards'];
    
    containers.forEach(containerId => {
        const container = document.getElementById(containerId);
        if (!container) return;
        
        container.removeEventListener('click', handleContainerDeleteClick);
        container.addEventListener('click', handleContainerDeleteClick);
    });
}

async function handleContainerDeleteClick(e) {
    const deleteBtn = e.target.closest('.delete-record-btn');
    if (!deleteBtn) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const sku = deleteBtn.getAttribute('data-sku');
    const productionDateVal = deleteBtn.getAttribute('data-production-date');
    
    if (!sku || !productionDateVal) {
        showQuickToast('无法删除：数据不完整', 'warning');
        return;
    }
    
    const name = deleteBtn.getAttribute('data-name');
    const shelfLifeVal = parseInt(deleteBtn.getAttribute('data-shelf-life') || 0);
    const reminderDaysVal = parseInt(deleteBtn.getAttribute('data-reminder-days') || 0);
    const location = deleteBtn.getAttribute('data-location');
    const category = deleteBtn.getAttribute('data-category') || '其他类';
    
    const item = {
        sku: sku,
        name: name,
        production_date: productionDateVal,
        shelf_life: shelfLifeVal,
        reminder_days: reminderDaysVal,
        location: location,
        category: category
    };
    
    const card = deleteBtn.closest('.expiring-card');
    const row = deleteBtn.closest('tr');
    
    currentSelectedItem = item;
    deleteType = 'record';
    window._pendingDeleteElements = { card, row };
    window._pendingDelete = { sku: sku, productionDate: productionDateVal };
    
    showDeleteConfirm(item, 'record');
}

// 分页渲染函数
// 修复 renderAllTablePaginated 函数（修复图片加载问题）
async function renderAllTablePaginated() {
    const startIndex = (allRecordsCurrentPage - 1) * 10;
    const endIndex = startIndex + 10;
    const pageData = allRecordsData.slice(startIndex, endIndex);
    
    const allTableElem = document.getElementById('allTable');
    if (!allTableElem) return;
    
    allTableElem.innerHTML = '';
    
    if (pageData.length === 0) {
        allTableElem.innerHTML = '<tr><td colspan="10" class="text-center py-4">📦 暂无库存商品</td></tr>';
        return;
    }
    
    // 预加载图片（使用优化的图片缓存管理器）
    const imagePromises = pageData.map(record => imageCacheManager.getImageUrl(record.sku));
    const imageResults = await Promise.all(imagePromises);
    
    for (let i = 0; i < pageData.length; i++) {
        const record = pageData[i];
        const remainingDaysVal = record.remaining_days;
        const reminderDaysVal = record.reminder_days || 0;
        
        let statusClass, statusText;
        if (remainingDaysVal <= 0) {
            statusClass = 'text-danger';
            statusText = '已过期';
        } else if (remainingDaysVal <= reminderDaysVal) {
            statusClass = 'text-warning';
            statusText = '临期';
        } else {
            statusClass = 'text-success';
            statusText = '正常';
        }
        
        const expiryDateVal = new Date(createBJDate(record.production_date));
        expiryDateVal.setUTCDate(expiryDateVal.getUTCDate() + record.shelf_life);
        
        const imageUrl = imageResults[i] || imageCacheManager.getFallbackUrl(record.sku);
        const row = document.createElement('tr');
        row.setAttribute('data-swipe-sku', record.sku);
        row.setAttribute('data-swipe-date', record.production_date);
        row.innerHTML = `
            <td class="image-cell" style="width:50px">
                <img src="${imageUrl}" 
                     class="product-image-sm" 
                     alt="${escapeHtml(record.name)}"
                     onerror="this.src='data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHZpZXdCb3g9IjAgMCA0MCA0MCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHJlY3Qgd2lkdGg9IjQwIiBoZWlnaHQ9IjQwIiBmaWxsPSIjZGRkIi8+Cjx0ZXh0IHg9IjIwIiB5PSIyMCIgZm9udC1mYW1pbHk9IkFyaWFsIiBmb250LXNpemU9IjE0IiBmaWxsPSIjOTk5IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iLjNlbSI+Tk8gSU1BR0U8L3RleHQ+Cjwvc3ZnPg==';">
            </td>
            <td class="sku-cell">${escapeHtml(record.sku)}</td>
            <td class="product-name-cell">${escapeHtml(record.name)}</td>
            <td class="category-cell">${escapeHtml(record.category || '其他类')}</td>
            <td class="location-cell">${escapeHtml(record.location || '默认位置')}</td>
            <td class="date-cell">${record.production_date}</td>
            <td class="date-cell">${formatDateLocal(expiryDateVal)}</td>
            <td class="days-cell">${remainingDaysVal > 0 ? remainingDaysVal : 0}</td>
            <td class="status-cell ${statusClass}">${statusText}</td>
            <td class="action-cell">
                <button class="btn btn-sm btn-danger delete-record-btn" 
                    data-sku="${escapeHtml(record.sku)}" 
                    data-name="${escapeHtml(record.name)}" 
                    data-production-date="${record.production_date}" 
                    data-shelf-life="${record.shelf_life}" 
                    data-reminder-days="${record.reminder_days}" 
                    data-location="${escapeHtml(record.location || '默认位置')}"
                    data-category="${escapeHtml(record.category || '其他类')}">
                    <i class="bi bi-trash"></i> 下架
                </button>
            </td>
        `;
        allTableElem.appendChild(row);
    }
    
    // 重新绑定删除按钮事件
    bindDeleteButtons();
    
    // 更新分页控件
    updatePaginationControls('all');
}

// 修复 renderDatabaseTablePaginated 函数

async function renderDatabaseTablePaginated() {
    const startIndex = (databaseCurrentPage - 1) * 10;
    const endIndex = startIndex + 10;
    const pageData = databaseData.slice(startIndex, endIndex);
    
    const tableBody = document.getElementById('productDatabaseTable');
    if (!tableBody) return;
    
    tableBody.innerHTML = '';
    
    if (pageData.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="8" class="text-center py-4">暂无商品数据</td></tr>';
        return;
    }
    
    for (const product of pageData) {
        let imageHtml = '<span class="text-muted">无图</span>';
        try {
            const imageData = await apiRequest(`/api/images/${product.sku}`);
            if (imageData?.image_data) imageHtml = `<img src="${imageData.image_data}" class="product-image" onclick="showImagePreview('${imageData.image_data}')" style="width:40px;height:40px;object-fit:cover;border-radius:8px;cursor:pointer">`;
        } catch(e) {}
        
        const row = document.createElement('tr');
        row.style.verticalAlign = 'middle';
        row.innerHTML = `
            <td class="image-cell" style="width:50px; vertical-align: middle;">${imageHtml}</td>
            <td class="sku-cell" style="vertical-align: middle;">${escapeHtml(product.sku)}</td>
            <td class="product-name-cell" style="vertical-align: middle;">${escapeHtml(product.name)}</td>
            <td class="category-cell" style="vertical-align: middle;">${escapeHtml(product.category || '其他类')}</td>
            <td class="days-cell" style="vertical-align: middle; text-align: center;">${product.shelf_life}</td>
            <td class="days-cell" style="vertical-align: middle; text-align: center;">${product.reminder_days}</td>
            <td class="location-cell" style="vertical-align: middle;">${escapeHtml(product.location)}</td>
            <td class="action-cell" style="vertical-align: middle; white-space: nowrap;">
                <button class="btn btn-sm btn-warning edit-product-btn me-1" data-sku="${escapeHtml(product.sku)}" style="padding: 4px 8px; font-size: 12px;">
                    <i class="bi bi-pencil"></i> 编辑
                </button>
                <button class="btn btn-sm btn-danger delete-product-btn" data-sku="${escapeHtml(product.sku)}" data-name="${escapeHtml(product.name)}" data-shelf-life="${product.shelf_life}" data-reminder-days="${product.reminder_days}" data-location="${escapeHtml(product.location)}" data-category="${escapeHtml(product.category || '其他类')}" style="padding: 4px 8px; font-size: 12px;">
                    <i class="bi bi-trash"></i> 删除
                </button>
            </td>
        `;
        tableBody.appendChild(row);
    }
    
    // 重新绑定按钮事件
    document.querySelectorAll('.edit-product-btn').forEach(btn => {
        btn.removeEventListener('click', handleEditProduct);
        btn.addEventListener('click', handleEditProduct);
    });
    document.querySelectorAll('.delete-product-btn').forEach(btn => {
        btn.removeEventListener('click', handleDeleteProduct);
        btn.addEventListener('click', handleDeleteProduct);
    });
    
    updatePaginationControls('database');
}

function updatePaginationControls(type) {
    if (type === 'all') {
        const container = document.getElementById('allPagination');
        if (!container) return;
        
        container.innerHTML = `
            <button class="btn btn-sm btn-outline-secondary" onclick="changeAllPage('prev')" ${allRecordsCurrentPage === 1 ? 'disabled' : ''}>
                <i class="bi bi-chevron-left"></i> 上一页
            </button>
            <span class="page-info">第 ${allRecordsCurrentPage} / ${allRecordsTotalPages} 页</span>
            <button class="btn btn-sm btn-outline-secondary" onclick="changeAllPage('next')" ${allRecordsCurrentPage === allRecordsTotalPages ? 'disabled' : ''}>
                下一页 <i class="bi bi-chevron-right"></i>
            </button>
            <span class="page-info">共 ${allRecordsData.length} 条记录</span>
        `;
        
        // 手机端分页
        const mobileContainer = document.getElementById('allPaginationMobile');
        if (mobileContainer && window.innerWidth <= 768) {
            mobileContainer.style.display = 'flex';
            mobileContainer.innerHTML = container.innerHTML;
        }
    } else if (type === 'database') {
        const container = document.getElementById('databasePagination');
        if (!container) return;
        
        container.innerHTML = `
            <button class="btn btn-sm btn-outline-secondary" onclick="changeDatabasePage('prev')" ${databaseCurrentPage === 1 ? 'disabled' : ''}>
                <i class="bi bi-chevron-left"></i> 上一页
            </button>
            <span class="page-info">第 ${databaseCurrentPage} / ${databaseTotalPages} 页</span>
            <button class="btn btn-sm btn-outline-secondary" onclick="changeDatabasePage('next')" ${databaseCurrentPage === databaseTotalPages ? 'disabled' : ''}>
                下一页 <i class="bi bi-chevron-right"></i>
            </button>
            <span class="page-info">共 ${databaseData.length} 条商品</span>
        `;
    }
}

window.changeAllPage = function(direction) {
    if (direction === 'prev' && allRecordsCurrentPage > 1) {
        allRecordsCurrentPage--;
    } else if (direction === 'next' && allRecordsCurrentPage < allRecordsTotalPages) {
        allRecordsCurrentPage++;
    }
    renderAllTablePaginated();
    // 滚动到顶部
    document.getElementById('all')?.scrollIntoView({ behavior: 'smooth' });
};

window.changeDatabasePage = function(direction) {
    if (direction === 'prev' && databaseCurrentPage > 1) {
        databaseCurrentPage--;
    } else if (direction === 'next' && databaseCurrentPage < databaseTotalPages) {
        databaseCurrentPage++;
    }
    renderDatabaseTablePaginated();
    document.getElementById('add')?.scrollIntoView({ behavior: 'smooth' });
};

async function initMainApp() {
    if (appInitialized) return;
    appInitialized = true;
    
    if (!document.querySelector('#delete-animation-style')) {
        const style = document.createElement('style');
        style.id = 'delete-animation-style';
        style.textContent = `
            tr.delete-animate {
                animation: rowSlideOut 0.25s cubic-bezier(0.4, 0, 0.2, 1) forwards !important;
                pointer-events: none !important;
            }
            @keyframes rowSlideOut {
                0% { transform: translateX(0); opacity: 1; background-color: #fff; }
                30% { transform: translateX(30%); opacity: 0.8; background-color: #f8d7da; }
                100% { transform: translateX(100%); opacity: 0; display: none; }
            }
            @media (max-width: 768px) {
                .expiring-card.delete-animate {
                    animation: cardSlideOutMobile 0.25s cubic-bezier(0.4, 0, 0.2, 1) forwards !important;
                    pointer-events: none !important;
                }
            }
            @keyframes cardSlideOutMobile {
                0% { transform: translateX(0); opacity: 1; max-height: 300px; padding: 14px; margin-bottom: 12px; background-color: #fff; }
                30% { transform: translateX(-30%); opacity: 0.7; background-color: #f8d7da; }
                100% { transform: translateX(-100%); opacity: 0; max-height: 0; padding: 0; margin: 0; margin-bottom: 0; display: none; }
            }
            tr.delete-animate td {
                animation: tdFadeOut 0.25s ease-out forwards !important;
            }
            @keyframes tdFadeOut {
                0% { transform: translateX(0); opacity: 1; }
                100% { transform: translateX(50px); opacity: 0; }
            }
            .expiring-card {
                --delete-opacity: 0;
            }
            .expiring-card::after {
                opacity: var(--delete-opacity, 0);
                transition: opacity 0.1s ease;
            }
        `;
        document.head.appendChild(style);
    }
    
    const confirmModalElem = document.getElementById('confirmModal');
    const duplicateModalElem = document.getElementById('duplicateModal');
    const scannerModalElem = document.getElementById('scannerModal');
    const imagePreviewModalElem = document.getElementById('imagePreviewModal');
    const resetPasswordModalElem = document.getElementById('resetPasswordModal');
    const validityModalElem = document.getElementById('validityModal');
    const editCodeModalElem = document.getElementById('editCodeModal');
    const changePwdModalElem = document.getElementById('changePwdModal');
    const verifyPasswordModalElem = document.getElementById('verifyPasswordModal');
    
    if (confirmModalElem) {
        confirmModal = new bootstrap.Modal(confirmModalElem);
        confirmModalElem.addEventListener('hidden.bs.modal', function() {
            cleanupModalBackdrops();
        });
    }
    if (duplicateModalElem) duplicateModal = new bootstrap.Modal(duplicateModalElem);
    if (scannerModalElem) scannerModal = new bootstrap.Modal(scannerModalElem);
    if (imagePreviewModalElem) imagePreviewModal = new bootstrap.Modal(imagePreviewModalElem);
    if (resetPasswordModalElem) resetPasswordModal = new bootstrap.Modal(resetPasswordModalElem);
    if (validityModalElem) validityModal = new bootstrap.Modal(validityModalElem);
    if (editCodeModalElem) editCodeModal = new bootstrap.Modal(editCodeModalElem);
    if (changePwdModalElem) changePwdModal = new bootstrap.Modal(changePwdModalElem);
    if (verifyPasswordModalElem) verifyPasswordModal = new bootstrap.Modal(verifyPasswordModalElem);
    
    const today = getBJToday();
    const minDate = new Date(today);
    minDate.setUTCFullYear(today.getUTCFullYear() - 2);
    
    if (productionDate) {
        productionDate.min = formatDateLocal(minDate);
        productionDate.max = formatDateLocal(today);
    }
    
    // 初始化分类筛选器
    initCategoryFilter();
    
    // 初始化最近删除按钮
    const clearAllDeletedBtn = document.getElementById('clearAllDeletedBtn');
    if (clearAllDeletedBtn) {
        clearAllDeletedBtn.addEventListener('click', clearAllDeletedItems);
    }
    const refreshDeletedBtn = document.getElementById('refreshDeletedBtn');
    if (refreshDeletedBtn) {
        refreshDeletedBtn.addEventListener('click', () => renderDeletedList());
    }
    
    try {
        await Promise.all([
            renderExpiringTable(false),
            renderAllTable(false),
            renderProductDatabaseTable()
        ]);
        
        // 初始化待出清表计数
        updateRecentClearanceCount();
        
        if (currentUserRole === 'admin') {
            await loadUsers();
            await loadAuthCodes();
            await loadLogs();
        }
    } catch (error) { 
        console.error('初始化错误:', error);
    }
    
    setTimeout(() => { 
        if (skuInput) skuInput.focus(); 
        showQuickToast('系统已就绪', 'info');
    }, 100);
    startAuthChecker();
    setupImageUpload();
    bindRefreshButtons();
    addLogoutAndClearBtn();
    showTimezoneInfo();
    initSwipeToDelete();
    
    // 加载最近删除记录
    loadDeletedItems();
}

function initCategoryFilter() {
    const filterContainer = document.getElementById('expiringCategoryFilter');
    if (!filterContainer) return;
    
    filterContainer.querySelectorAll('[data-category]').forEach(btn => {
        btn.removeEventListener('click', handleCategoryFilter);
        btn.addEventListener('click', handleCategoryFilter);
    });
}

function handleCategoryFilter(e) {
    const btn = e.currentTarget;
    const category = btn.getAttribute('data-category');
    
    // 更新按钮状态
    const container = btn.closest('.btn-group');
    if (container) {
        container.querySelectorAll('[data-category]').forEach(b => {
            b.classList.remove('active');
        });
    }
    btn.classList.add('active');
    
    currentExpiringCategory = category;
    renderExpiringTable(true);
}

function showTimezoneInfo() {
    setTimeout(() => {
        const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const now = new Date();
        const utcOffset = -now.getTimezoneOffset() / 60;
        const offsetSign = utcOffset >= 0 ? '+' : '-';
        const offsetAbs = Math.abs(utcOffset);
        
        let footer = document.querySelector('.timezone-footer');
        if (!footer) {
            footer = document.createElement('div');
            footer.className = 'timezone-footer';
            footer.style.cssText = 'text-align:center;font-size:11px;color:#999;margin-top:20px;padding:10px;';
            document.body.appendChild(footer);
        }
        footer.innerHTML = `服务器时区: ${userTimezone} (UTC${offsetSign}${offsetAbs}:00) | 服务器区域:Ashburn USA | `;
    }, 500);
}

async function lookupProductWithExistingDates() {
    const sku = skuInput.value.trim();
    if (sku.length !== 5) { clearForm(); return; }
    try {
        const product = await apiRequest(`/api/products/global/${sku}`);
        if (product) {
            productName.value = product.name;
            shelfLife.value = product.shelf_life;
            reminderDays.value = product.reminder_days;
            productCategory.value = product.category || '其他类';
            if (productLocation) productLocation.textContent = product.location || '默认位置';
            productionDate.disabled = false;
            const today = getBJToday();
            productionDate.value = formatDateLocal(today);
            calculateDates();
            showQuickToast(`已找到商品：${product.name}`, 'success');
            
            // 在找到商品后立即显示已有日期
            setTimeout(() => {
                showExistingDates();
            }, 100);
            
            setTimeout(() => {
                if (productionDate && !productionDate.disabled) {
                    productionDate.focus();
                    if (window.innerWidth <= 768) {
                        productionDate.click();
                    }
                }
            }, 200);
        } else {
            productName.value = ''; shelfLife.value = ''; reminderDays.value = ''; productCategory.value = '';
            if (productLocation) productLocation.textContent = '-';
            productionDate.value = ''; productionDate.disabled = true; clearResults();
            showAlert(`SKU "${sku}" 不存在，请先在"新增商品"中添加`, 'warning');
        }
    } catch (error) { clearForm(); }
}

function clearForm() {
    productName.value = ''; shelfLife.value = ''; reminderDays.value = ''; productCategory.value = '';
    if (productLocation) productLocation.textContent = '-';
    productionDate.value = ''; productionDate.disabled = true; clearResults();
    if (skuInput) skuInput.focus();
}

function clearResults() {
    if (expiryDate) expiryDate.textContent = '-';
    if (reminderDate) reminderDate.textContent = '-';
    if (remainingDays) remainingDays.textContent = '-';
    if (statusIndicator) statusIndicator.innerHTML = '';
}

function calculateDates() {
    if (!productionDate.value || !shelfLife.value) return;
    try {
        const prodDateStr = productionDate.value;
        const shelfLifeDays = parseInt(shelfLife.value) || 0;
        const reminderDaysValue = parseInt(reminderDays.value) || 0;
        
        if (shelfLifeDays <= 0) {
            clearResults();
            return;
        }
        
        const prodDate = createBJDate(prodDateStr);
        const expiryDateVal = new Date(prodDate);
        expiryDateVal.setUTCDate(prodDate.getUTCDate() + shelfLifeDays);
        
        const reminderDateVal = new Date(expiryDateVal);
        reminderDateVal.setUTCDate(expiryDateVal.getUTCDate() - reminderDaysValue);
        
        const today = getBJToday();
        const remainingDaysValue = Math.ceil((expiryDateVal.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
        
        expiryDate.textContent = formatDateLocal(expiryDateVal);
        reminderDate.textContent = formatDateLocal(reminderDateVal);
        remainingDays.textContent = remainingDaysValue > 0 ? `${remainingDaysValue}天` : '已过期';
        
        updateStatusIndicator(remainingDaysValue, shelfLifeDays);
    } catch(e) {
        console.error('日期计算错误:', e);
        clearResults();
    }
}

function updateStatusIndicator(remainingDaysVal, shelfLifeVal) {
    if (remainingDaysVal <= 0) {
        statusIndicator.innerHTML = `<div class="text-center text-danger"><i class="bi bi-exclamation-triangle"></i> 已过期</div>`;
        return;
    }
    const percentage = Math.min(100, Math.max(0, (remainingDaysVal / shelfLifeVal) * 100));
    const reminderDaysValue = parseInt(reminderDays.value) || 0;
    let statusClass, statusText;
    if (remainingDaysVal <= reminderDaysValue) {
        statusClass = 'text-warning';
        statusText = '<i class="bi bi-exclamation-triangle"></i> 临期';
    } else {
        statusClass = 'text-success';
        statusText = '<i class="bi bi-check-circle"></i> 正常';
    }
    statusIndicator.innerHTML = `<div style="height:15px;border-radius:8px;background:linear-gradient(90deg,#dc3545 0%,#ffc107 50%,#28a745 100%);position:relative;"><div style="position:absolute;top:-5px;left:${percentage}%;width:8px;height:25px;background:#343a40;transform:translateX(-50%);border-radius:4px;"></div></div><div class="text-center mt-2 ${statusClass}">${statusText}</div>`;
}

async function saveProductRecord(isManual = true) {
    if (isManual) {
        cancelAutoSaveFlag = false;
        if (autoSaveTimer) {
            clearTimeout(autoSaveTimer);
            autoSaveTimer = null;
        }
        const timerDiv = document.getElementById('autoSaveTimer');
        if (timerDiv) timerDiv.style.display = 'none';
    }
    
    if (!isManual && cancelAutoSaveFlag) {
        cancelAutoSaveFlag = false;
        return;
    }
    
    const sku = skuInput.value.trim();
    const prodDate = productionDate.value;
    
    if (!sku || sku.length !== 5) { 
        if (isManual) showAlert('请输入有效的5位SKU编码', 'warning'); 
        return; 
    }
    if (!prodDate) { 
        if (isManual) showAlert('请选择生产日期', 'warning'); 
        return; 
    }
    
    const prodDateObj = createBJDate(prodDate);
    const today = getBJToday();
    if (prodDateObj > today) {
        if (isManual) showAlert('生产日期不能是未来日期', 'warning');
        return;
    }
    
    if (!productName.value) {
        if (isManual) showAlert('请先查询商品信息', 'warning');
        return;
    }
    if (!shelfLife.value || !reminderDays.value) {
        if (isManual) showAlert('保质期或提醒天数缺失，请重新查询商品信息后再保存', 'warning');
        return;
    }
    
    try {
        const records = await apiRequest(`/api/records/by-sku/${sku}`);
        const duplicate = records.find(r => r.production_date === prodDate);
        if (duplicate) {
            duplicateCheckResult = duplicate;
            const duplicateBody = document.getElementById('duplicateBody');
            if (duplicateBody) {
                duplicateBody.innerHTML = `<div class="alert alert-warning"><h5>发现重复记录</h5><p>相同SKU和生产日期的商品已存在</p><ul><li><strong>商品：</strong>${duplicate.name}</li><li><strong>SKU：</strong>${duplicate.sku}</li><li><strong>生产日期：</strong>${duplicate.production_date}</li></ul><p class="text-danger">是否继续添加？</p></div>`;
            }
            if (duplicateModal) duplicateModal.show();
            return;
        }
        const loc = await getProductLocation(sku);
        const record = {
            sku, name: productName.value, production_date: prodDate,
            shelf_life: parseInt(shelfLife.value), reminder_days: parseInt(reminderDays.value),
            location: loc || '默认位置',
            category: productCategory.value || '其他类'
        };
        await apiRequest('/api/records', 'POST', record);
        showQuickToast('商品已成功保存', 'success');
        dataCache.clear();
        skuInput.value = ''; 
        clearForm(); 
        if (skuInput) skuInput.focus();
        await renderExpiringTable(true);
        await renderAllTable(true);
    } catch (error) { 
        if (isManual) showAlert(`保存失败: ${error.message}`, 'danger'); 
    }
}

window.confirmDuplicate = function() {
    if (duplicateModal) duplicateModal.hide();
    if (duplicateCheckResult) {
        const record = { ...duplicateCheckResult };
        apiRequest('/api/records', 'POST', record).then(async () => {
            showQuickToast('商品已保存', 'success');
            dataCache.clear();
            skuInput.value = ''; clearForm(); if (skuInput) skuInput.focus();
            await renderExpiringTable(true);
            await renderAllTable(true);
        }).catch(e => showAlert(`保存失败: ${e.message}`, 'danger'));
    }
    duplicateCheckResult = null;
};

window.cancelDuplicate = function() { 
    if (duplicateModal) duplicateModal.hide(); 
    duplicateCheckResult = null; 
    if (productionDate) productionDate.focus(); 
};

async function searchProduct() {
    const sku = searchSku.value.trim();
    if (!sku || sku.length !== 5) { showAlert('请输入5位SKU编码', 'warning'); return; }
    try {
        const product = await apiRequest(`/api/products/${sku}`);
        if (product) {
            newSku.value = product.sku; 
            newName.value = product.name;
            newShelfLife.value = product.shelf_life; 
            newReminderDays.value = product.reminder_days;
            newCategory.value = product.category || '其他类';
            newLocation.value = product.location;
            isEditingProduct = true; 
            currentEditingSku = sku;
            newSku.readOnly = true;
            addProductBtn.classList.add('d-none'); 
            updateProductBtn.classList.remove('d-none');
            await loadProductImage(sku);
            showQuickToast(`已加载商品信息`, 'success');
        } else {
            newSku.value = sku; 
            newName.value = ''; 
            newShelfLife.value = ''; 
            newReminderDays.value = ''; 
            newCategory.value = '其他类';
            newLocation.value = '';
            isEditingProduct = false; 
            currentEditingSku = '';
            newSku.readOnly = false;
            addProductBtn.classList.remove('d-none'); 
            updateProductBtn.classList.add('d-none');
            currentImageData = null; 
            if (imagePreviewContainer) imagePreviewContainer.innerHTML = ''; 
            if (removeImageBtn) removeImageBtn.style.display = 'none';
            newName.focus();
            showAlert(`未找到商品，可以添加新商品`, 'info');
        }
    } catch (error) { showAlert(`查询失败: ${error.message}`, 'danger'); }
}

async function addNewProduct() {
    const sku = newSku.value.trim(); 
    const name = newName.value.trim();
    const shelfLifeVal = newShelfLife.value.trim(); 
    const reminderVal = newReminderDays.value.trim();
    const category = newCategory.value;
    const location = newLocation.value.trim();
    
    if (!sku || !name || !shelfLifeVal || !reminderVal || !location) { 
        showAlert('请填写所有商品信息', 'warning'); 
        return; 
    }
    if (sku.length !== 5) { 
        showAlert('SKU必须为5位编码', 'warning'); 
        return; 
    }
    const shelfLifeNum = parseInt(shelfLifeVal); 
    const reminderNum = parseInt(reminderVal);
    if (isNaN(shelfLifeNum) || shelfLifeNum <= 0) { 
        showAlert('请输入有效的保质期天数', 'warning'); 
        return; 
    }
    if (isNaN(reminderNum) || reminderNum < 0) { 
        showAlert('请输入有效的提醒天数', 'warning'); 
        return; 
    }
    if (reminderNum > shelfLifeNum) { 
        showAlert('临期提醒天数不能大于保质期天数', 'warning'); 
        return; 
    }
    try {
        // 检查该SKU是否已有图片
        const existingImage = await apiRequest(`/api/images/${sku}`);
        if (existingImage && existingImage.image_data) {
            // 如果已有图片，清空图片选择器并提示用户
            if (currentImageData) {
                currentImageData = null;
                currentImageMime = null;
                if (imagePreviewContainer) imagePreviewContainer.innerHTML = '';
                if (removeImageBtn) removeImageBtn.style.display = 'none';
                if (productImageInput) productImageInput.value = '';
                showQuickToast('该SKU已有图片，已清空当前选择的图片', 'info');
            }
        }
        
        await apiRequest('/api/products', 'POST', {
            sku, name, shelf_life: shelfLifeNum, reminder_days: reminderNum,
            category: category, location
        });
        
        // 只有在没有现有图片且当前有图片数据时才上传图片
        if (currentImageData && (!existingImage || !existingImage.image_data)) {
            await saveProductImage(sku);
        }
        
        showQuickToast('商品已成功添加到数据库', 'success');
        dataCache.clear();
        newSku.value = ''; newName.value = ''; newShelfLife.value = '';
        newReminderDays.value = ''; newCategory.value = '其他类'; newLocation.value = '';
        searchSku.value = '';
        currentImageData = null;
        if (imagePreviewContainer) imagePreviewContainer.innerHTML = '';
        if (removeImageBtn) removeImageBtn.style.display = 'none';
        showQuickToast('商品已添加，记得手动刷新商品数据库表', 'info');
    } catch (error) { showAlert(`添加失败: ${error.message}`, 'danger'); }
}

async function updateProduct() {
    const name = newName.value.trim(); 
    const shelfLifeVal = newShelfLife.value.trim();
    const reminderVal = newReminderDays.value.trim(); 
    const category = newCategory.value;
    const location = newLocation.value.trim();
    
    if (!name || !shelfLifeVal || !reminderVal || !location) { 
        showAlert('请填写所有商品信息', 'warning'); 
        return; 
    }
    const shelfLifeNum = parseInt(shelfLifeVal); 
    const reminderNum = parseInt(reminderVal);
    if (isNaN(shelfLifeNum) || shelfLifeNum <= 0) { 
        showAlert('请输入有效的保质期天数', 'warning'); 
        return; 
    }
    if (isNaN(reminderNum) || reminderNum < 0) { 
        showAlert('请输入有效的提醒天数', 'warning'); 
        return; 
    }
    if (reminderNum > shelfLifeNum) { 
        showAlert('临期提醒天数不能大于保质期天数', 'warning'); 
        return; 
    }
    try {
        await apiRequest(`/api/products/${currentEditingSku}`, 'PUT', {
            name, shelf_life: shelfLifeNum, reminder_days: reminderNum,
            category, location
        });
        
        // 更新商品时允许更换图片，直接根据当前图片状态处理
        if (currentImageData) {
            await saveProductImage(currentEditingSku);
        } else if (hadExistingImage) {
            // 仅当该商品原本存在图片、且用户主动删除时才调用删除接口；
            // 若原本就无图片，则不调用 DELETE，避免后端返回 404 触发报错。
            await deleteProductImage(currentEditingSku);
        }
        
        showQuickToast('商品信息已更新', 'success');
        dataCache.clear();
        isEditingProduct = false;
        currentEditingSku = '';
        newSku.readOnly = false;
        newSku.value = '';
        newName.value = '';
        newShelfLife.value = '';
        newReminderDays.value = '';
        newCategory.value = '其他类';
        newLocation.value = '';
        searchSku.value = '';
        currentImageData = null;
        if (imagePreviewContainer) imagePreviewContainer.innerHTML = '';
        if (removeImageBtn) removeImageBtn.style.display = 'none';
        addProductBtn.classList.remove('d-none');
        updateProductBtn.classList.add('d-none');
        showQuickToast('商品已更新，记得手动刷新商品数据库表', 'info');
    } catch (error) { showAlert(`更新失败: ${error.message}`, 'danger'); }
}

async function updateExpiryWarning() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/auth/check`, { credentials: 'include' });
        const result = await response.json();
        if (result.isLoggedIn && result.user?.expiryWarning) {
            expiryWarningText.textContent = result.user.expiryWarning;
            expiryWarningBar.style.display = 'block';
            if (result.user.expiryWarning.includes('已过期')) {
                expiryWarningBar.classList.add('expiry-danger-bar');
            }
        } else {
            expiryWarningBar.style.display = 'none';
            expiryWarningBar.classList.remove('expiry-danger-bar');
        }
    } catch(e) {}
}

// 更新菜单按钮上的badge - 只显示对应标签页的动态数字
async function updateMenuButtonBadge(targetTab = null) {
    try {
        let count = 0;
        
        // 只根据指定标签页显示对应的数量，不显示总数
        if (targetTab === 'expiring') {
            const expiringRecords = await dataCache.getExpiring(true);
            count = expiringRecords.length;
        } else if (targetTab === 'clearance') {
            const clearanceRecords = await dataCache.getClearance(true);
            count = clearanceRecords.length;
        } else if (targetTab === 'recent-clearance') {
            count = recentClearanceList.length;
        } else {
            // 没有指定标签页时，不显示数字，只显示图标
            count = 0;
        }
        
        const menuBtnBadge = document.getElementById('menuBtnBadge');
        const menuBtnIcon = document.querySelector('.mobile-menu-btn i');
        
        if (menuBtnBadge) {
            menuBtnBadge.textContent = count > 99 ? '99+' : count;
            menuBtnBadge.classList.toggle('d-none', count === 0);
        }
        
        // 控制图标显示：有数字时隐藏图标，无数字时显示图标
        if (menuBtnIcon) {
            menuBtnIcon.classList.toggle('d-none', count > 0);
        }
        
        // 调试日志
        console.log('菜单按钮数字更新:', {
            targetTab: targetTab,
            count: count,
            display: count > 99 ? '99+' : count,
            showIcon: count === 0
        });
    } catch(e) {
        console.error('更新菜单按钮数字失败:', e);
    }
}

async function updateExpiryCount() {
		    try {
		        const expiringRecords = await dataCache.getExpiring(false);
		        const expiringCount = expiringRecords.length;
		        
		        // 更新PC端标签页的badge
		        const expiringTab = document.getElementById('expiring-tab');
		        if (expiringTab) {
		            const existingBadge = expiringTab.querySelector('.expiry-count-badge');
		            if (existingBadge) existingBadge.remove();
		            if (expiringCount > 0) {
		                const badge = document.createElement('span');
		                badge.className = 'badge bg-danger ms-1 expiry-count-badge';
		                badge.textContent = expiringCount;
		                expiringTab.appendChild(badge);
		            }
		        }
		        
		        // 更新菜单按钮上的badge - 显示临期商品数量
		        updateMenuButtonBadge('expiring');
		    } catch(e) {}
		}

// 更新建议出清计数
	async function updateClearanceCount(forceRefresh = false) {
		    try {
		        const clearanceRecords = await dataCache.getClearance(forceRefresh);
		        const clearanceCount = clearanceRecords.length;
		        
		        // 更新PC端标签页的badge
		        const clearanceTab = document.getElementById('clearance-tab');
		        if (clearanceTab) {
		            const existingBadge = clearanceTab.querySelector('.clearance-count-badge');
		            if (existingBadge) existingBadge.remove();
		            if (clearanceCount > 0) {
		                const badge = document.createElement('span');
		                badge.className = 'badge bg-warning ms-1 clearance-count-badge';
		                badge.textContent = clearanceCount;
		                clearanceTab.appendChild(badge);
		            }
		        }
		        
		        // 更新菜单按钮上的badge - 显示建议出清数量
		        updateMenuButtonBadge('clearance');
		    } catch(e) {}
		}
	
// 更新待出清表计数
		async function updateRecentClearanceCount() {
		    try {
	    // 清理过期记录（3天前）
	    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
	    recentClearanceList = recentClearanceList.filter(record => record.clear_timestamp > threeDaysAgo);
	    localStorage.setItem('recentClearanceList', JSON.stringify(recentClearanceList));
		        
		        const recentClearanceCount = recentClearanceList.length;
		        
		        // 更新PC端标签页的badge
		        const recentClearanceTab = document.getElementById('recent-clearance-tab');
		        if (recentClearanceTab) {
		            const existingBadge = recentClearanceTab.querySelector('.recent-clearance-count-badge');
		            if (existingBadge) existingBadge.remove();
		            if (recentClearanceCount > 0) {
		                const badge = document.createElement('span');
		                badge.className = 'badge bg-warning ms-1 recent-clearance-count-badge';
		                badge.textContent = recentClearanceCount;
		                recentClearanceTab.appendChild(badge);
		            }
		        }
		        
		        // 更新菜单按钮上的badge - 显示待出清表数量
		        updateMenuButtonBadge('recent-clearance');
		    } catch(e) {}
		}
		
		// 只更新待出清表标签页的badge，不更新菜单按钮
		async function updateRecentClearanceCountBadgeOnly() {
		    try {
	    // 清理过期记录（3天前）
	    const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
	    recentClearanceList = recentClearanceList.filter(record => record.clear_timestamp > threeDaysAgo);
	    localStorage.setItem('recentClearanceList', JSON.stringify(recentClearanceList));
		        
		        const recentClearanceCount = recentClearanceList.length;
		        
		        // 只更新PC端标签页的badge
		        const recentClearanceTab = document.getElementById('recent-clearance-tab');
		        if (recentClearanceTab) {
		            const existingBadge = recentClearanceTab.querySelector('.recent-clearance-count-badge');
		            if (existingBadge) existingBadge.remove();
		            if (recentClearanceCount > 0) {
		                const badge = document.createElement('span');
		                badge.className = 'badge bg-warning ms-1 recent-clearance-count-badge';
		                badge.textContent = recentClearanceCount;
		                recentClearanceTab.appendChild(badge);
		            }
		        }
		        
		        // 不更新菜单按钮，避免数字混乱
		    } catch(e) {}
		}
	
async function renderExpiringTable(forceRefresh = false) {
    // 防止重复渲染的锁机制
    if (isRenderingExpiringTable) {
        console.log('临期表正在渲染中，跳过本次调用');
        return;
    }
    isRenderingExpiringTable = true;
    
    if (window.innerWidth <= 768) {
        showCardsLoading('expiringCards', true, '加载临期商品...');
    } else {
        showTableLoading('expiringTable', true, '加载临期商品...');
    }
    
    try {
        let expiringRecords = await dataCache.getExpiring(forceRefresh);
        
        // 应用分类筛选
        if (currentExpiringCategory !== 'all') {
            expiringRecords = expiringRecords.filter(r => (r.category || '其他类') === currentExpiringCategory);
        }
        
        const expiringTableElem = document.getElementById('expiringTable');
        const expiringCards = document.getElementById('expiringCards');
        
        if (!expiringTableElem) return;
        
        if (window.innerWidth <= 768) {
            if (expiringCards) {
                // 确保彻底清空容器，避免重复显示
                while (expiringCards.firstChild) {
                    expiringCards.removeChild(expiringCards.firstChild);
                }
            }
        } else {
            expiringTableElem.innerHTML = '';
        }
        
        if (!expiringRecords || expiringRecords.length === 0) {
            const noDataMsg = currentExpiringCategory !== 'all' ? `暂无${currentExpiringCategory}的临期商品` : '暂无临期商品';
            if (window.innerWidth <= 768) {
                if (expiringCards) expiringCards.innerHTML = `<div class="text-center py-5 text-muted"><i class="bi bi-check-circle" style="font-size: 2rem;"></i><p class="mt-2">${noDataMsg}</p></div>`;
            } else {
                expiringTableElem.innerHTML = `<tr><td colspan="10" class="text-center py-4">${noDataMsg}</td></tr>`;
            }
            await updateExpiryCount();
            return;
        }
        
        await updateExpiryCount();
        
        const imageCache = new Map();
        const imagePromises = expiringRecords.map(record => getProductImageUrl(record.sku));
        const imageResults = await Promise.all(imagePromises);
        expiringRecords.forEach((record, idx) => {
            if (imageResults[idx]) imageCache.set(record.sku, imageResults[idx]);
        });
        
        for (const record of expiringRecords) {
            const remainingDaysVal = record.remaining_days;
            const expiryDateVal = new Date(createBJDate(record.production_date));
            expiryDateVal.setUTCDate(expiryDateVal.getUTCDate() + record.shelf_life);
            
            const imageUrl = imageCache.get(record.sku);
            const imageHtml = imageUrl 
                ? `<img src="${imageUrl}" class="product-image-sm" onclick="showImagePreview('${imageUrl}')" style="width:40px;height:40px;object-fit:cover;border-radius:6px;cursor:pointer" alt="${escapeHtml(record.name)}">`
                : '<span class="text-muted" style="font-size:12px;">无图</span>';
            
            // 根据屏幕尺寸决定渲染表格还是卡片
            if (window.innerWidth > 768) {
                // 桌面端：只渲染表格
                const row = document.createElement('tr');
                row.setAttribute('data-swipe-sku', record.sku);
                row.setAttribute('data-swipe-date', record.production_date);
                row.innerHTML = `
                    <td class="image-cell" style="width:50px">${imageHtml}</td>
                    <td class="sku-cell">${escapeHtml(record.sku)}</div>
                    <td class="product-name-cell">${escapeHtml(record.name)}</div>
                    <td class="category-cell">${escapeHtml(record.category || '其他类')}</div>
                    <td class="location-cell">${escapeHtml(record.location || '默认位置')}</div>
                    <td class="date-cell">${record.production_date}</div>
                    <td class="date-cell">${formatDateLocal(expiryDateVal)}</div>
                    <td class="days-cell">${remainingDaysVal > 0 ? remainingDaysVal : 0}</div>
                    <td class="status-cell ${remainingDaysVal <= 0 ? 'text-danger' : 'text-warning'}">${remainingDaysVal <= 0 ? '已过期' : '临期'}</div>
                    <td class="action-cell">
                        <button class="btn btn-sm btn-danger delete-record-btn" 
                            data-sku="${escapeHtml(record.sku)}" 
                            data-name="${escapeHtml(record.name)}" 
                            data-production-date="${record.production_date}" 
                            data-shelf-life="${record.shelf_life}" 
                            data-reminder-days="${record.reminder_days}" 
                            data-location="${escapeHtml(record.location || '默认位置')}"
                            data-category="${escapeHtml(record.category || '其他类')}">
                            <i class="bi bi-trash"></i> 下架
                        </button>
                    </div>
                `;
                expiringTableElem.appendChild(row);
            } else {
                // 移动端：只渲染卡片
                if (expiringCards) {
                    const card = document.createElement('div');
                    card.className = `expiring-card ${remainingDaysVal <= 0 ? 'danger' : 'warning'}`;
                    card.innerHTML = `
                        <div class="card-inner">
                            <div class="card-header-row">
                                <div class="card-sku">${escapeHtml(record.sku)}</div>
                                <div class="category-badge ${getCategoryClass(record.category || '其他类')}">${escapeHtml(record.category || '其他类')}</div>
                                <div class="card-status ${remainingDaysVal <= 0 ? 'status-danger-bg' : 'status-warning-bg'}">${remainingDaysVal <= 0 ? '已过期' : '临期'}</div>
                            </div>
	                            <div class="d-flex align-items-start mb-3">
	                                <div class="d-flex align-items-start">
	                                    ${imageUrl ? `<img src="${imageUrl}" class="card-image-thumb me-3" onclick="showImagePreview('${imageUrl}')" alt="${escapeHtml(record.name)}">` : ''}
	                                    <div class="flex-grow-1">
	                                        <div class="card-info-item">
	                                            <div class="card-info-label">商品名称</div>
	                                            <div class="card-info-value name-value">${escapeHtml(record.name)}</div>
	                                        </div>
	                                    </div>
	                                </div>
	                            </div>
                            <div class="card-body-grid">
                                <div class="card-info-item">
                                    <div class="card-info-label">📦 库位</div>
                                    <div class="card-info-value location-value">${escapeHtml(record.location || '默认位置')}</div>
                                </div>
                                <div class="card-info-item">
                                    <div class="card-info-label">⏳ 剩余</div>
                                    <div class="card-info-value days-value">${remainingDaysVal > 0 ? remainingDaysVal : 0}<span class="days-unit">天</span></div>
                                </div>
                                <div class="card-info-item">
                                    <div class="card-info-label">📅 生产日期</div>
                                    <div class="card-info-value date-value">${record.production_date}</div>
                                </div>
                                <div class="card-info-item">
                                    <div class="card-info-label">⚠️ 到期日期</div>
                                    <div class="card-info-value date-value">${formatDateLocal(expiryDateVal)}</div>
                                </div>
                            </div>
                            <button class="delete-record-btn d-none" 
                                data-sku="${escapeHtml(record.sku)}" 
                                data-name="${escapeHtml(record.name)}" 
                                data-production-date="${record.production_date}" 
                                data-shelf-life="${record.shelf_life}" 
                                data-reminder-days="${record.reminder_days}" 
                                data-location="${escapeHtml(record.location || '默认位置')}"
                                data-category="${escapeHtml(record.category || '其他类')}">
                            </button>
                            <div class="swipe-hint">
                                <i class="bi bi-arrow-left-short"></i>
                                <span>左滑删除</span>
                            </div>
                        </div>
                    `;
                    expiringCards.appendChild(card);
                }
            }
        }
        
        bindDeleteButtons();
        initSwipeToDelete();
    } catch (error) {
        console.error('渲染临期商品错误:', error);
        const expiringTableElem = document.getElementById('expiringTable');
        const expiringCards = document.getElementById('expiringCards');
        if (window.innerWidth <= 768) {
            if (expiringCards) expiringCards.innerHTML = '<div class="text-center py-5 text-danger">加载失败，请刷新重试</div>';
        } else {
            if (expiringTableElem) expiringTableElem.innerHTML = '<tr><td colspan="10" class="text-center py-4 text-danger">加载失败，请刷新重试</td></tr>';
        }
    } finally {
        // 释放渲染锁
        isRenderingExpiringTable = false;
    }
}

async function renderAllTable(forceRefresh = false) {
    if (window.innerWidth <= 768) {
        showCardsLoading('allCards', true, '加载商品列表...');
    } else {
        showTableLoading('allTable', true, '加载商品列表...');
    }
    
    try {
        const records = await dataCache.getRecords(forceRefresh);
        
        const allCards = document.getElementById('allCards');
        
        if (window.innerWidth <= 768) {
            if (allCards) {
                // 确保彻底清空容器，避免重复显示
                while (allCards.firstChild) {
                    allCards.removeChild(allCards.firstChild);
                }
                if (!records || records.length === 0) {
                    allCards.innerHTML = '<div class="text-center py-5 text-muted"><i class="bi bi-box" style="font-size: 2rem;"></i><p class="mt-2">暂无库存商品</p></div>';
                    return;
                }
                
                // 切换标签页后再加载图片（使用优化的图片缓存管理器）
                const imagePromises = records.map(record => imageCacheManager.getImageUrl(record.sku));
                const imageResults = await Promise.all(imagePromises);
                
                for (let i = 0; i < records.length; i++) {
                    const record = records[i];
                    const remainingDaysVal = record.remaining_days;
                    const reminderDaysVal = record.reminder_days || 0;
                    
                    let cardClass, statusBgClass, statusText;
                    if (remainingDaysVal <= 0) {
                        cardClass = 'danger';
                        statusBgClass = 'status-danger-bg';
                        statusText = '已过期';
                    } else if (remainingDaysVal <= reminderDaysVal) {
                        cardClass = 'warning';
                        statusBgClass = 'status-warning-bg';
                        statusText = '临期';
                    } else {
                        cardClass = 'normal';
                        statusBgClass = 'status-normal-bg';
                        statusText = '正常';
                    }
                    
                    const expiryDateVal = new Date(createBJDate(record.production_date));
                    expiryDateVal.setUTCDate(expiryDateVal.getUTCDate() + record.shelf_life);
                    
            const imageUrl = imageResults[i] || imageCacheManager.getFallbackUrl(record.sku);
                    
                    const card = document.createElement('div');
                    card.className = `expiring-card ${cardClass}`;
                    card.innerHTML = `
                        <div class="card-inner">
                            <div class="card-header-row">
                                <div class="card-sku">${escapeHtml(record.sku)}</div>
                                <div class="category-badge ${getCategoryClass(record.category || '其他类')}">${escapeHtml(record.category || '其他类')}</div>
                                <div class="card-status ${statusBgClass}">${statusText}</div>
                            </div>
	                            <div class="d-flex align-items-start mb-3">
	                                <div class="d-flex align-items-start">
	                                    ${imageUrl ? `<img src="${imageUrl}" class="card-image-thumb me-3" onclick="showImagePreview('${imageUrl}')" alt="${escapeHtml(record.name)}">` : ''}
	                                    <div class="flex-grow-1">
	                                        <div class="card-info-item">
	                                            <div class="card-info-label">商品名称</div>
	                                            <div class="card-info-value name-value">${escapeHtml(record.name)}</div>
	                                        </div>
	                                    </div>
	                                </div>
	                            </div>
                            <div class="card-body-grid">
                                <div class="card-info-item">
                                    <div class="card-info-label">📦 库位</div>
                                    <div class="card-info-value location-value">${escapeHtml(record.location || '默认位置')}</div>
                                </div>
                                <div class="card-info-item">
                                    <div class="card-info-label">⏳ 剩余</div>
                                    <div class="card-info-value days-value">${remainingDaysVal > 0 ? remainingDaysVal : 0}<span class="days-unit">天</span></div>
                                </div>
                                <div class="card-info-item">
                                    <div class="card-info-label">📅 生产日期</div>
                                    <div class="card-info-value date-value">${record.production_date}</div>
                                </div>
                                <div class="card-info-item">
                                    <div class="card-info-label">⚠️ 到期日期</div>
                                    <div class="card-info-value date-value">${formatDateLocal(expiryDateVal)}</div>
                                </div>
                            </div>
                            <button class="delete-record-btn d-none" 
                                data-sku="${escapeHtml(record.sku)}" 
                                data-name="${escapeHtml(record.name)}" 
                                data-production-date="${record.production_date}" 
                                data-shelf-life="${record.shelf_life}" 
                                data-reminder-days="${record.reminder_days}" 
                                data-location="${escapeHtml(record.location || '默认位置')}"
                                data-category="${escapeHtml(record.category || '其他类')}">
                            </button>
                            <div class="swipe-hint">
                                <i class="bi bi-arrow-left-short"></i>
                                <span>左滑删除</span>
                            </div>
                        </div>
                    `;
                    allCards.appendChild(card);
                }
                bindDeleteButtons();
                initSwipeToDelete();
            }
        } else {
            // PC端：使用分页
            allRecordsData = records || [];
            allRecordsTotalPages = Math.ceil(allRecordsData.length / 10);
            allRecordsCurrentPage = 1;
            renderAllTablePaginated();
        }
        
        bindDeleteButtons();
        
        // 更新菜单栏计数显示
        updateMenuBadgeCounts();
    } catch (error) {
        console.error('渲染所有商品错误:', error);
        const allTableElem = document.getElementById('allTable');
        if (allTableElem && window.innerWidth > 768) {
            allTableElem.innerHTML = '<tr><td colspan="10" class="text-center py-4 text-danger">加载失败，请刷新重试</td></tr>';
        }
    }
}

// 修复 renderProductDatabaseTable 函数

async function renderProductDatabaseTable(forceRefresh = false) {
    const tableBody = document.getElementById('productDatabaseTable');
    if (!tableBody) return;
    
    tableBody.innerHTML = `
        <tr class="table-loading-row">
            <td colspan="8" class="text-center py-5">
                <div class="spinner-border text-primary" role="status" style="width: 2rem; height: 2rem;">
                    <span class="visually-hidden">加载中...</span>
                </div>
                <div class="mt-2 text-muted">加载商品数据库...</div>
            </td>
        </tr>
    `;
    
    try {
        const products = await dataCache.getProducts(forceRefresh);
        databaseData = products || [];
        databaseTotalPages = Math.ceil(databaseData.length / 10);
        databaseCurrentPage = 1;
        await renderDatabaseTablePaginated();
    } catch (error) { 
        console.error('加载失败:', error); 
        tableBody.innerHTML = '<tr><td colspan="8" class="text-center py-4 text-danger">加载失败，请刷新重试</td></tr>';
    }
}

function handleEditProduct(e) {
    const btn = e.currentTarget;
    const sku = btn.getAttribute('data-sku');
    showEditModal({ sku });
}

function handleDeleteProduct(e) {
    const btn = e.currentTarget;
    const product = {
        sku: btn.getAttribute('data-sku'),
        name: btn.getAttribute('data-name'),
        shelf_life: parseInt(btn.getAttribute('data-shelf-life')),
        reminder_days: parseInt(btn.getAttribute('data-reminder-days')),
        location: btn.getAttribute('data-location'),
        category: btn.getAttribute('data-category') || '其他类'
    };
    showDeleteConfirm(product, 'product');
}

async function exportUserData() {
    try {
        showAlert('正在导出数据...', 'info');
        const response = await fetch(`${API_BASE_URL}/api/export`, { credentials: 'include' });
        if (!response.ok) throw new Error('导出失败');
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `mydata_${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showAlert('数据导出成功', 'success');
    } catch (error) { 
        showAlert(`导出失败: ${error.message}`, 'danger'); 
    }
}

function importUserData() {
    const fileInput = document.getElementById('importUserFileInput');
    if (fileInput) fileInput.click();
    if (fileInput) {
        fileInput.onchange = async function(e) {
            const file = e.target.files[0];
            if (!file) return;
            showAlert('正在导入数据...', 'info');
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                const result = await apiRequest('/api/import', 'POST', data);
                showAlert(`导入成功: 商品新增${result.results.productsAdded}个，更新${result.results.productsUpdated}个，库存新增${result.results.recordsAdded}条，图片${result.results.imagesAdded}张`, 'success');
                dataCache.clear();
                await renderProductDatabaseTable(true);
                await renderAllTable(true);
                await renderExpiringTable(true);
            } catch (error) { 
                showAlert(`导入失败: ${error.message}`, 'danger'); 
            }
            fileInput.value = '';
        };
    }
}

function showVerifyPasswordForReset() {
    const passwordInput = document.getElementById('verifyPassword');
    if (passwordInput) passwordInput.value = '';
    if (verifyPasswordModal) verifyPasswordModal.show();
}

async function verifyAndResetData() {
    const password = document.getElementById('verifyPassword')?.value;
    
    if (!password) {
        showAlert('请输入登录密码', 'warning');
        return;
    }
    
    const confirmBtn = document.getElementById('confirmVerifyResetBtn');
    const originalText = confirmBtn?.innerHTML;
    if (confirmBtn) {
        confirmBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 验证中...';
        confirmBtn.disabled = true;
    }
    
    try {
        const result = await apiRequest('/api/user/verify-password', 'POST', { password });
        
        if (result.valid) {
            if (verifyPasswordModal) verifyPasswordModal.hide();
            await executeResetData();
        } else {
            showAlert('密码错误，无法执行清空操作', 'danger');
        }
    } catch (error) {
        showAlert(`验证失败: ${error.message}`, 'danger');
    } finally {
        if (confirmBtn) {
            confirmBtn.innerHTML = originalText;
            confirmBtn.disabled = false;
        }
        const passwordInput = document.getElementById('verifyPassword');
        if (passwordInput) passwordInput.value = '';
    }
}

async function executeResetData() {
    try {
        showAlert('正在清空数据...', 'info');
        const result = await apiRequest('/api/reset', 'POST');
        showAlert(result.message || '数据已清空', 'success');
        dataCache.clear();
        await renderProductDatabaseTable(true);
        await renderAllTable(true);
        await renderExpiringTable(true);
        if (newSku) newSku.value = '';
        if (newName) newName.value = '';
        if (newShelfLife) newShelfLife.value = '';
        if (newReminderDays) newReminderDays.value = '';
        if (newCategory) newCategory.value = '其他类';
        if (newLocation) newLocation.value = '';
        if (searchSku) searchSku.value = '';
    } catch (error) { 
        showAlert(`清空失败: ${error.message}`, 'danger'); 
    }
}

function showChangePasswordModal() {
    const oldPassword = document.getElementById('oldPassword');
    const newPassword = document.getElementById('newPassword');
    const confirmNewPassword = document.getElementById('confirmNewPassword');
    if (oldPassword) oldPassword.value = '';
    if (newPassword) newPassword.value = '';
    if (confirmNewPassword) confirmNewPassword.value = '';
    if (changePwdModal) changePwdModal.show();
}

async function changePassword() {
    const oldPassword = document.getElementById('oldPassword')?.value;
    const newPassword = document.getElementById('newPassword')?.value;
    const confirmNewPassword = document.getElementById('confirmNewPassword')?.value;
    
    if (!oldPassword || !newPassword) {
        showAlert('请填写完整信息', 'warning');
        return;
    }
    if (newPassword.length < 6) {
        showAlert('新密码长度至少6位', 'warning');
        return;
    }
    if (newPassword !== confirmNewPassword) {
        showAlert('两次输入的新密码不一致', 'warning');
        return;
    }
    
    try {
        await apiRequest('/api/user/change-password', 'POST', {
            oldPassword,
            newPassword
        });
        showAlert('密码修改成功，请重新登录', 'success');
        if (changePwdModal) changePwdModal.hide();
        setTimeout(() => logout(), 2000);
    } catch (error) {
        showAlert(`修改失败: ${error.message}`, 'danger');
    }
}

async function loadUsers() {
    try {
        const users = await apiRequest('/api/admin/users');
        const tbody = document.getElementById('usersTable');
        if (!tbody) return;
        tbody.innerHTML = '';
        for (const user of users) {
            const row = document.createElement('tr');
            row.innerHTML = `
                <td>${user.id}</div>
                <td>${escapeHtml(user.username)}</div>
                <td>${user.role === 'admin' ? '<span class="badge bg-danger">管理员</span>' : '<span class="badge bg-secondary">普通用户</span>'}</div>
                <td>${user.created_at ? user.created_at.slice(0,10) : '-'}</div>
                <td>${user.last_login ? user.last_login.slice(0,10) : '-'}</div>
                <td>${user.valid_until || '永久'}${user.valid_until && new Date(user.valid_until) < new Date() ? '<span class="badge bg-danger ms-1">已过期</span>' : ''}</div>
                <td>${user.role !== 'admin' ? '<button class="btn btn-sm btn-warning me-1" onclick="showResetPasswordModal(' + user.id + ', \'' + escapeHtml(user.username) + '\')"><i class="bi bi-key"></i> 重置密码</button><button class="btn btn-sm btn-info me-1" onclick="showValidityModal(' + user.id + ', \'' + (user.valid_until || '') + '\')"><i class="bi bi-calendar"></i> 续期</button><button class="btn btn-sm btn-danger" onclick="deleteUser(' + user.id + ', \'' + escapeHtml(user.username) + '\')"><i class="bi bi-trash"></i> 删除</button>' : '<span class="text-muted">-</span>'}</div>
            `;
            tbody.appendChild(row);
        }
    } catch (error) { console.error('加载用户失败:', error); }
}

async function loadAuthCodes() {
    try {
        const codes = await apiRequest('/api/admin/auth-codes');
        const tbody = document.getElementById('codesTable');
        if (!tbody) return;
        tbody.innerHTML = '';
        for (const code of codes) {
            const statusBadge = code.status === 'active' ? '<span class="badge bg-success">有效</span>' : (code.status === 'used' ? '<span class="badge bg-secondary">已使用</span>' : '<span class="badge bg-danger">已失效</span>');
            const row = document.createElement('tr');
            row.innerHTML = `
                <td><code class="auth-code">${code.code}</code></div>
                <td>${code.created_by_name || '-'}</div>
                <td>${code.valid_until}</div>
                <td>${statusBadge}</div>
                <td>${code.used_by_name || '-'}</div>
                <td>${code.status === 'active' ? `<button class="btn btn-sm btn-warning" onclick="editAuthCode(${code.id}, '${code.valid_until}')"><i class="bi bi-pencil"></i> 编辑</button>` : '-'}</div>
            `;
            tbody.appendChild(row);
        }
    } catch (error) { console.error('加载授权码失败:', error); }
}

async function loadLogs() {
    try {
        const logs = await apiRequest('/api/admin/logs');
        const tbody = document.getElementById('logsTable');
        if (!tbody) return;
        tbody.innerHTML = '';
        for (const log of logs.slice(0, 100)) {
            const row = document.createElement('tr');
            row.innerHTML = `<td>${log.created_at?.slice(0,19) || '-'}</div><td>${log.admin_name || '-'}</div><td>${log.action}</div><td>${log.target_user || '-'}</div><td>${log.details || '-'}</div>`;
            tbody.appendChild(row);
        }
    } catch (error) { console.error('加载日志失败:', error); }
}

window.showResetPasswordModal = function(userId, username) {
    const resetUserId = document.getElementById('resetUserId');
    const resetNewPassword = document.getElementById('resetNewPassword');
    const resetConfirmPassword = document.getElementById('resetConfirmPassword');
    if (resetUserId) resetUserId.value = userId;
    if (resetNewPassword) resetNewPassword.value = '';
    if (resetConfirmPassword) resetConfirmPassword.value = '';
    if (resetPasswordModal) resetPasswordModal.show();
};

window.showValidityModal = function(userId, currentValidUntil) {
    const validityUserId = document.getElementById('validityUserId');
    const validityDate = document.getElementById('validityDate');
    if (validityUserId) validityUserId.value = userId;
    const defaultDate = currentValidUntil || (() => { let d = new Date(); d.setMonth(d.getMonth() + 6); return d.toISOString().split('T')[0]; })();
    if (validityDate) validityDate.value = defaultDate;
    if (validityModal) validityModal.show();
};

window.editAuthCode = function(codeId, validUntil) {
    const editCodeId = document.getElementById('editCodeId');
    const editCodeValidUntil = document.getElementById('editCodeValidUntil');
    const editCodeStatus = document.getElementById('editCodeStatus');
    if (editCodeId) editCodeId.value = codeId;
    if (editCodeValidUntil) editCodeValidUntil.value = validUntil;
    if (editCodeStatus) editCodeStatus.value = 'active';
    if (editCodeModal) editCodeModal.show();
};

window.deleteUser = async function(userId, username) {
    if (confirm(`确定要删除用户 "${username}" 吗？此操作不可恢复！`)) {
        try {
            await apiRequest(`/api/admin/users/${userId}`, 'DELETE');
            showAlert(`用户 ${username} 已删除`, 'success');
            await loadUsers();
        } catch (error) { showAlert(`删除失败: ${error.message}`, 'danger'); }
    }
};

async function generateAuthCode() {
    const validUntil = document.getElementById('newCodeValidUntil').value;
    if (!validUntil) { showAlert('请选择有效期', 'warning'); return; }
    try {
        const result = await apiRequest('/api/admin/auth-codes', 'POST', { validUntil });
        const resultDiv = document.getElementById('newCodeResult');
        if (resultDiv) {
            resultDiv.innerHTML = `<i class="bi bi-key"></i> 新授权码: <code class="auth-code">${result.code}</code><br>有效期至: ${result.validUntil}<br><button class="btn btn-sm btn-outline-primary mt-2" onclick="copyToClipboard('${result.code}')"><i class="bi bi-copy"></i> 复制</button>`;
            resultDiv.style.display = 'block';
        }
        await loadAuthCodes();
        setTimeout(() => { if (resultDiv) resultDiv.style.display = 'none'; }, 10000);
    } catch (error) { showAlert(`生成失败: ${error.message}`, 'danger'); }
}

window.copyToClipboard = function(text) {
    navigator.clipboard.writeText(text);
    showAlert('已复制到剪贴板', 'success');
};

async function confirmResetPassword() {
    const userId = document.getElementById('resetUserId')?.value;
    const newPassword = document.getElementById('resetNewPassword')?.value;
    const confirmPassword = document.getElementById('resetConfirmPassword')?.value;
    if (!newPassword || newPassword.length < 6) { showAlert('密码长度不能少于6位', 'warning'); return; }
    if (newPassword !== confirmPassword) { showAlert('两次输入的密码不一致', 'warning'); return; }
    try {
        await apiRequest(`/api/admin/users/${userId}/reset-password`, 'POST', { newPassword });
        showAlert('密码已重置', 'success');
        if (resetPasswordModal) resetPasswordModal.hide();
    } catch (error) { showAlert(`重置失败: ${error.message}`, 'danger'); }
}

async function confirmValidity() {
    const userId = document.getElementById('validityUserId')?.value;
    const validUntil = document.getElementById('validityDate')?.value;
    if (!validUntil) { showAlert('请选择有效期', 'warning'); return; }
    try {
        await apiRequest(`/api/admin/users/${userId}/validity`, 'POST', { validUntil });
        showAlert('有效期已更新', 'success');
        if (validityModal) validityModal.hide();
        await loadUsers();
    } catch (error) { showAlert(`更新失败: ${error.message}`, 'danger'); }
}

async function confirmEditCode() {
    const codeId = document.getElementById('editCodeId')?.value;
    const validUntil = document.getElementById('editCodeValidUntil')?.value;
    const status = document.getElementById('editCodeStatus')?.value;
    try {
        await apiRequest(`/api/admin/auth-codes/${codeId}`, 'PUT', { validUntil, status });
        showAlert('授权码已更新', 'success');
        if (editCodeModal) editCodeModal.hide();
        await loadAuthCodes();
    } catch (error) { showAlert(`更新失败: ${error.message}`, 'danger'); }
}

async function exportData() {
    try {
        const response = await fetch(`${API_BASE_URL}/api/export`, { credentials: 'include' });
        if (!response.ok) throw new Error('导出失败');
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `export_${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showAlert('数据导出成功', 'success');
    } catch (error) { showAlert(`导出失败: ${error.message}`, 'danger'); }
}

function importData() {
    const fileInput = document.getElementById('importFileInput');
    if (fileInput) fileInput.click();
    if (fileInput) {
        fileInput.onchange = async function(e) {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const text = await file.text();
                const data = JSON.parse(text);
                const result = await apiRequest('/api/import', 'POST', data);
                showAlert(`导入成功: 商品新增${result.results.productsAdded}个，更新${result.results.productsUpdated}个，库存新增${result.results.recordsAdded}条，图片${result.results.imagesAdded}张`, 'success');
                dataCache.clear();
                await renderProductDatabaseTable(true);
                await renderAllTable(true);
            } catch (error) { showAlert(`导入失败: ${error.message}`, 'danger'); }
            fileInput.value = '';
        };
    }
}

function bindRefreshButtons() {
    const refreshBtns = document.querySelectorAll('.refresh-btn');
    refreshBtns.forEach(btn => {
        btn.removeEventListener('click', handleRefresh);
        btn.addEventListener('click', handleRefresh);
    });
}

async function handleRefresh(e) {
    const btn = e.currentTarget;
    const table = btn.getAttribute('data-table');
    showQuickToast('正在刷新...', 'info');
    dataCache.clear();
    if (table === 'expiring') {
        await renderExpiringTable(true);
    } else if (table === 'all') {
        await renderAllTable(true);
    } else if (table === 'database') {
        await renderProductDatabaseTable(true);
    }
    showQuickToast('刷新完成', 'success');
}

// 移动端左侧菜单栏初始化
function initMobileSidebar() {
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const mobileSidebar = document.getElementById('mobileSidebar');
    const sidebarCloseBtn = document.getElementById('sidebarCloseBtn');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const sidebarMenuItems = document.querySelectorAll('.sidebar-menu-item');
    
    // 检查是否为移动端，显示相关元素
    function checkMobile() {
        if (window.innerWidth <= 768) {
            if (mobileMenuBtn) mobileMenuBtn.classList.remove('d-none');
            if (mobileSidebar) mobileSidebar.classList.remove('d-none');
            if (sidebarOverlay) sidebarOverlay.classList.remove('d-none');
        } else {
            if (mobileMenuBtn) mobileMenuBtn.classList.add('d-none');
            if (mobileSidebar) mobileSidebar.classList.add('d-none');
            if (sidebarOverlay) sidebarOverlay.classList.add('d-none');
            // 桌面端关闭侧边栏
            if (mobileSidebar) mobileSidebar.classList.remove('active');
            if (sidebarOverlay) sidebarOverlay.classList.remove('active');
        }
    }
    
    // 初始化时检查
    checkMobile();
    
    // 监听窗口大小变化
    window.addEventListener('resize', checkMobile);
    
    // 打开菜单（支持展开/关闭切换）
    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', () => {
            const isActive = mobileSidebar && mobileSidebar.classList.contains('active');
            if (isActive) {
                // 如果菜单已展开，则关闭
                closeSidebar();
            } else {
                // 如果菜单未展开，则打开
                if (mobileSidebar) mobileSidebar.classList.add('active');
                if (sidebarOverlay) sidebarOverlay.classList.add('active');
            }
        });
    }
    
    // 关闭菜单（关闭按钮）
    if (sidebarCloseBtn) {
        sidebarCloseBtn.addEventListener('click', closeSidebar);
    }
    
    // 关闭菜单（遮罩层点击）
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', closeSidebar);
    }
    
    // 菜单项点击事件
    sidebarMenuItems.forEach(item => {
        item.addEventListener('click', function() {
            const target = this.getAttribute('data-target');
            if (target) {
                // 切换到对应的标签页
                switchTab(target);
                // 关闭菜单
                closeSidebar();
            }
        });
    });
    
    // 关闭菜单函数
    function closeSidebar() {
        if (mobileSidebar) mobileSidebar.classList.remove('active');
        if (sidebarOverlay) sidebarOverlay.classList.remove('active');
    }
    
    // 切换标签页函数
    function switchTab(targetId) {
        // 找到对应的标签页按钮并点击
        const targetTab = document.getElementById(`${targetId}-tab`);
        if (targetTab) {
            targetTab.click();
        }
        
        // 更新侧边栏菜单项的激活状态
        sidebarMenuItems.forEach(item => {
            if (item.getAttribute('data-target') === targetId) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    }
    
    // 监听标签页切换事件，同步更新侧边栏菜单状态
    const tabButtons = document.querySelectorAll('[data-bs-toggle="tab"]');
    tabButtons.forEach(button => {
        button.addEventListener('shown.bs.tab', function() {
            const targetId = this.getAttribute('data-bs-target').replace('#', '');
            sidebarMenuItems.forEach(item => {
                if (item.getAttribute('data-target') === targetId) {
                    item.classList.add('active');
                } else {
                    item.classList.remove('active');
                }
            });
        });
    });
}

document.addEventListener('DOMContentLoaded', () => {
    // 初始化DOM元素
    loginContainer = document.getElementById('login-container');
    mainApp = document.getElementById('main-app');
    loginBtn = document.getElementById('loginBtn');
    registerBtn = document.getElementById('registerBtn');
    logoutBtn = document.getElementById('logoutBtn');
    currentUsername = document.getElementById('current-username');
    expiryWarningBar = document.getElementById('expiryWarningBar');
    expiryWarningText = document.getElementById('expiryWarningText');
    
    skuInput = document.getElementById('skuInput');
    productName = document.getElementById('productName');
    shelfLife = document.getElementById('shelfLife');
    reminderDays = document.getElementById('reminderDays');
    productCategory = document.getElementById('productCategory');
    productionDate = document.getElementById('productionDate');
    expiryDate = document.getElementById('expiryDate');
    saveBtn = document.getElementById('saveBtn');

    
    // 生产日期的 change 监听统一在下方注册（含计算到期日、显示已有日期、条件触发自动保存），此处不再重复绑定
    reminderDate = document.getElementById('reminderDate');
    remainingDays = document.getElementById('remainingDays');
    statusIndicator = document.getElementById('statusIndicator');

    locationInput = document.getElementById('locationInput');
    // 注意：autoSaveTimer 是 setTimeout 定时器ID变量（见顶部 let autoSaveTimer = null），
    // 不能在此被覆盖为 DOM 元素，否则 clearTimeout 失效、倒计时无法取消。
    timerSeconds = document.getElementById('timerSeconds');
    searchSku = document.getElementById('searchSku');
    productLocation = document.getElementById('productLocation');
    
    // 绑定输入框事件
    if (skuInput) {
        skuInput.addEventListener('input', lookupProductWithExistingDates);
    }
    if (searchSku) {
        searchSku.addEventListener('input', function() {
            if (this.value.length === 5) {
                searchProduct();
            }
        });
    }
    searchProductName = document.getElementById('searchProductName');
    searchShelfLife = document.getElementById('searchShelfLife');
    searchReminderDays = document.getElementById('searchReminderDays');
    searchProductionDate = document.getElementById('searchProductionDate');
    searchExpiryDate = document.getElementById('searchExpiryDate');
    searchReminderDate = document.getElementById('searchReminderDate');
    searchRemainingDays = document.getElementById('searchRemainingDays');
    searchStatusIndicator = document.getElementById('searchStatusIndicator');
    searchCategory = document.getElementById('searchCategory');
    searchLocation = document.getElementById('searchLocation');
    newSku = document.getElementById('newSku');
    newName = document.getElementById('newName');
    newProductName = document.getElementById('newProductName');
    newShelfLife = document.getElementById('newShelfLife');
    newReminderDays = document.getElementById('newReminderDays');
    newCategory = document.getElementById('newCategory');
    newLocation = document.getElementById('newLocation');
    addProductBtn = document.getElementById('addProductBtn');
    updateProductBtn = document.getElementById('updateProductBtn');
    newProductionDate = document.getElementById('newProductionDate');
    newExpiryDate = document.getElementById('newExpiryDate');
    newReminderDate = document.getElementById('newReminderDate');
    newRemainingDays = document.getElementById('newRemainingDays');
    newStatusIndicator = document.getElementById('newStatusIndicator');
    allRecordsTable = document.getElementById('allRecordsTable');
    expiringTable = document.getElementById('expiringTable');
    allRecordsPagination = document.getElementById('allRecordsPagination');
    databaseTable = document.getElementById('databaseTable');
    databasePagination = document.getElementById('databasePagination');
    deleteConfirmModal = document.getElementById('deleteConfirmModal');
    deleteConfirmBtn = document.getElementById('deleteConfirmBtn');
    confirmDeleteBtn = document.getElementById('confirmDeleteBtn');
    const changePwdModalElem = document.getElementById('changePwdModal');
    const verifyPasswordModalElem = document.getElementById('verifyPasswordModal');
    const deleteModalElem = document.getElementById('deleteModal');
    const imageUploadModalElem = document.getElementById('imageUploadModal');
    const imagePreviewModalElem = document.getElementById('imagePreviewModal');
    const scannerModalElem = document.getElementById('scannerModal');  // 重新声明，因为在DOMContentLoaded作用域中不可见

    // 添加页面切换事件监听，设置currentActivePage
    document.addEventListener('shown.bs.tab', function (e) {
        const target = e.target;
        // 获取激活的tab页的ID或data-bs-target
        const tabId = target.getAttribute('data-bs-target') || target.getAttribute('href');
        // 将tabId映射到页面标识
        let pageId = '';
        if (tabId) {
            // 去掉#号，只保留页面标识
            pageId = tabId.replace('#', '');
        }
        
        // 设置当前激活页面
        window.currentActivePage = pageId;
        console.log('页面切换至:', pageId);
        
        // 更新菜单栏计数显示
        updateMenuBadgeCounts();
    });

    // 初始化时设置当前页面
    const activeTab = document.querySelector('.nav-link.active, .sidebar-menu-item.active');
    if (activeTab) {
        const tabId = activeTab.getAttribute('data-bs-target') || activeTab.getAttribute('data-target') || activeTab.getAttribute('href');
        if (tabId) {
            window.currentActivePage = tabId.replace('#', '');
            console.log('初始页面:', window.currentActivePage);
        }
    }
    changePwdModal = changePwdModalElem ? new bootstrap.Modal(changePwdModalElem) : null;
    verifyPasswordModal = verifyPasswordModalElem ? new bootstrap.Modal(verifyPasswordModalElem) : null;
    scannerModal = scannerModalElem ? new bootstrap.Modal(scannerModalElem) : null;
    deleteModal = deleteModalElem ? new bootstrap.Modal(deleteModalElem) : null;
    imageUploadModal = imageUploadModalElem ? new bootstrap.Modal(imageUploadModalElem) : null;
    imagePreviewModal = imagePreviewModalElem ? new bootstrap.Modal(imagePreviewModalElem) : null;
    imagePreview = document.getElementById('imagePreview');
    imageFileInput = document.getElementById('imageFileInput');
    imageUploadBtn = document.getElementById('imageUploadBtn');
    imageDeleteBtn = document.getElementById('imageDeleteBtn');
    imagePreviewCloseBtn = document.getElementById('imagePreviewCloseBtn');
    imageUploadProgress = document.getElementById('imageUploadProgress');
    imageUploadProgressText = document.getElementById('imageUploadProgressText');
    imageUploadProgressBar = document.getElementById('imageUploadProgressBar');
    imageUploadProgressContainer = document.getElementById('imageUploadProgressContainer');
    imageUploadDropArea = document.getElementById('imageUploadDropArea');
    imageUploadText = document.getElementById('imageUploadText');
    imageUploadIcon = document.getElementById('imageUploadIcon');
    imageUploadFileName = document.getElementById('imageUploadFileName');
    imageUploadFileSize = document.getElementById('imageUploadFileSize');
    imageUploadActions = document.getElementById('imageUploadActions');
    imageUploadCancelBtn = document.getElementById('imageUploadCancelBtn');
    imageUploadSubmitBtn = document.getElementById('imageUploadSubmitBtn');
    imageUploadDeleteBtn = document.getElementById('imageUploadDeleteBtn');
    imageUploadViewBtn = document.getElementById('imageUploadViewBtn');
    imageUploadRenameBtn = document.getElementById('imageUploadRenameBtn');
    const imageRenameModalElem = document.getElementById('imageRenameModal');
    imageRenameModal = imageRenameModalElem ? new bootstrap.Modal(imageRenameModalElem) : null;
    imageRenameInput = document.getElementById('imageRenameInput');
    imageRenameSubmitBtn = document.getElementById('imageRenameSubmitBtn');
    imageRenameOriginalName = document.getElementById('imageRenameOriginalName');
    imageRenameNewName = document.getElementById('imageRenameNewName');
    imageRenameExtension = document.getElementById('imageRenameExtension');
    imageRenamePreview = document.getElementById('imageRenamePreview');
    imageRenameSku = document.getElementById('imageRenameSku');
    imageRenameProductName = document.getElementById('imageRenameProductName');
    clearanceContainer = document.getElementById('clearanceContainer');
    clearancePagination = document.getElementById('clearancePagination');
    recentClearanceContainer = document.getElementById('recentClearanceContainer');
    recentClearanceCountBadge = document.getElementById('recent-clearance-count-badge');
    deletedListContainer = document.getElementById('deletedListContainer');
    deletedCountBadge = document.getElementById('deleted-count-badge');
    databaseCountBadge = document.getElementById('database-count-badge');
    expiringCountBadge = document.getElementById('expiring-count-badge');
    clearanceCountBadge = document.getElementById('clearance-count-badge');
    allCountBadge = document.getElementById('all-count-badge');
    lastRefreshTime = document.getElementById('lastRefreshTime');
    userRoleDisplay = document.getElementById('userRoleDisplay');
    adminTabLi = document.getElementById('admin-tab-li');
    changepwdTabLi = document.getElementById('changepwd-tab-li');
    databaseTabLi = document.getElementById('database-tab-li');
    addTabLi = document.getElementById('add-tab-li');
    homeTabLi = document.getElementById('home-tab-li');
    expiringTabLi = document.getElementById('expiring-tab-li');
    clearanceTabLi = document.getElementById('clearance-tab-li');
    recentClearanceTabLi = document.getElementById('recent-clearance-tab-li');
    allTabLi = document.getElementById('all-tab-li');
    deletedTabLi = document.getElementById('deleted-tab-li');
    mainAppTabs = document.getElementById('mainAppTabs');
    
    // Tab元素定义
    expiringTab = document.getElementById('expiring-tab');
    allTab = document.getElementById('all-tab');
    clearanceTab = document.getElementById('clearance-tab');
    addTab = document.getElementById('add-tab');
    deletedTab = document.getElementById('deleted-tab');
    adminTab = document.getElementById('admin-tab');
    sidebarMenuItems = document.querySelectorAll('.sidebar-menu-item');
    sidebarLogoutBtn = document.getElementById('sidebarLogoutBtn');
    sidebarUsername = document.getElementById('sidebar-username');
    sidebarOverlay = document.getElementById('sidebarOverlay');
    menuToggleBtn = document.getElementById('menuToggleBtn');
    mobileSidebar = document.getElementById('mobileSidebar');
    changePasswordForm = document.getElementById('changePasswordForm');
    currentPassword = document.getElementById('currentPassword');
    newPassword = document.getElementById('newPassword');
    confirmPassword = document.getElementById('confirmPassword');
    changePasswordSubmitBtn = document.getElementById('changePasswordSubmitBtn');
    changePwdBtn = document.getElementById('changePwdBtn');
    exportDataBtn = document.getElementById('exportDataBtn');
    importDataBtn = document.getElementById('importDataBtn');
    resetDataBtn = document.getElementById('resetDataBtn');
    cleanExpiredBtn = document.getElementById('cleanExpiredBtn');
    refreshUsersBtn = document.getElementById('refreshUsersBtn');
    refreshCodesBtn = document.getElementById('refreshCodesBtn');
    refreshLogsBtn = document.getElementById('refreshLogsBtn');
    generateCodeBtn = document.getElementById('generateCodeBtn');
    confirmResetPasswordBtn = document.getElementById('confirmResetPasswordBtn');
    confirmValidityBtn = document.getElementById('confirmValidityBtn');
    confirmEditCodeBtn = document.getElementById('confirmEditCodeBtn');
    usersTable = document.getElementById('usersTable');
    codesTable = document.getElementById('codesTable');
    logsTable = document.getElementById('logsTable');
    newCodeValidUntil = document.getElementById('newCodeValidUntil');
    newValidityDate = document.getElementById('newValidityDate');
    editCodeValidUntil = document.getElementById('editCodeValidUntil');
    editCodeStatus = document.getElementById('editCodeStatus');
    editCodeId = document.getElementById('editCodeId');
    const editCodeModalElem = document.getElementById('editCodeModal');
    editCodeModal = editCodeModalElem ? new bootstrap.Modal(editCodeModalElem) : null;
    resetPasswordUserId = document.getElementById('resetPasswordUserId');
    resetPasswordUsername = document.getElementById('resetPasswordUsername');
    resetPasswordNewPassword = document.getElementById('resetPasswordNewPassword');
    const resetPasswordModalElem = document.getElementById('resetPasswordModal');
    resetPasswordModal = resetPasswordModalElem ? new bootstrap.Modal(resetPasswordModalElem) : null;
    validityUserId = document.getElementById('validityUserId');
    validityUsername = document.getElementById('validityUsername');
    validityDate = document.getElementById('validityDate');
    const validityModalElem = document.getElementById('validityModal');
    validityModal = validityModalElem ? new bootstrap.Modal(validityModalElem) : null;
    verifyPassword = document.getElementById('verifyPassword');
    confirmVerifyResetBtn = document.getElementById('confirmVerifyResetBtn');
    verifyPasswordModalTitle = document.getElementById('verifyPasswordModalTitle');
    verifyPasswordModalBody = document.getElementById('verifyPasswordModalBody');
    const exportModalElem = document.getElementById('exportModal');
    exportModal = exportModalElem ? new bootstrap.Modal(exportModalElem) : null;
    exportProgress = document.getElementById('exportProgress');
    exportProgressText = document.getElementById('exportProgressText');
    exportProgressBar = document.getElementById('exportProgressBar');
    const importModalElem = document.getElementById('importModal');
    importModal = importModalElem ? new bootstrap.Modal(importModalElem) : null;
    importFileInput = document.getElementById('importFileInput');
    importProgress = document.getElementById('importProgress');
    importProgressText = document.getElementById('importProgressText');
    importProgressBar = document.getElementById('importProgressBar');
    importResults = document.getElementById('importResults');
    importCancelButton = document.getElementById('importCancelButton');
    importConfirmButton = document.getElementById('importConfirmButton');
    const importConfirmModalElem = document.getElementById('importConfirmModal');
    importConfirmModal = importConfirmModalElem ? new bootstrap.Modal(importConfirmModalElem) : null;
    importConfirmResults = document.getElementById('importConfirmResults');
    importConfirmCancelButton = document.getElementById('importConfirmCancelButton');
    importConfirmProceedButton = document.getElementById('importConfirmProceedButton');
    importSkipButton = document.getElementById('importSkipButton');
    importOverwriteButton = document.getElementById('importOverwriteButton');
    importMergeButton = document.getElementById('importMergeButton');
    importStrategyButtons = document.querySelectorAll('[name="importStrategy"]');
    importConfirmStrategy = document.getElementById('importConfirmStrategy');
    importConfirmDetails = document.getElementById('importConfirmDetails');
    importSkipAllButton = document.getElementById('importSkipAllButton');
    importOverwriteAllButton = document.getElementById('importOverwriteAllButton');
    importMergeAllButton = document.getElementById('importMergeAllButton');
    importSkipAllConfirmButton = document.getElementById('importSkipAllConfirmButton');
    importOverwriteAllConfirmButton = document.getElementById('importOverwriteAllConfirmButton');
    importMergeAllConfirmButton = document.getElementById('importMergeAllConfirmButton');
    const importSkipAllModalElem = document.getElementById('importSkipAllModal');
    const importOverwriteAllModalElem = document.getElementById('importOverwriteAllModal');
    const importMergeAllModalElem = document.getElementById('importMergeAllModal');
    importSkipAllModal = importSkipAllModalElem ? new bootstrap.Modal(importSkipAllModalElem) : null;
    importOverwriteAllModal = importOverwriteAllModalElem ? new bootstrap.Modal(importOverwriteAllModalElem) : null;
    importMergeAllModal = importMergeAllModalElem ? new bootstrap.Modal(importMergeAllModalElem) : null;
    const importStrategyModalElem = document.getElementById('importStrategyModal');
    importStrategyModal = importStrategyModalElem ? new bootstrap.Modal(importStrategyModalElem) : null;
    importStrategySelect = document.getElementById('importStrategySelect');
    importStrategyConfirmBtn = document.getElementById('importStrategyConfirmBtn');
    importStrategyCancelBtn = document.getElementById('importStrategyCancelBtn');
    importResultsContainer = document.getElementById('importResultsContainer');
    importResultsHeader = document.getElementById('importResultsHeader');
    importResultsBody = document.getElementById('importResultsBody');
    importResultsFooter = document.getElementById('importResultsFooter');
    importResultsCloseBtn = document.getElementById('importResultsCloseBtn');
    importResultsExportBtn = document.getElementById('importResultsExportBtn');
    const importResultsExportModalElem = document.getElementById('importResultsExportModal');
    importResultsExportModal = importResultsExportModalElem ? new bootstrap.Modal(importResultsExportModalElem) : null;
    importResultsExportTextarea = document.getElementById('importResultsExportTextarea');
    importResultsExportCopyBtn = document.getElementById('importResultsExportCopyBtn');
    importResultsExportDownloadBtn = document.getElementById('importResultsExportDownloadBtn');
    importResultsExportCloseBtn = document.getElementById('importResultsExportCloseBtn');
    importResultsExportSuccessMsg = document.getElementById('importResultsExportSuccessMsg');
    importResultsExportErrorMsg = document.getElementById('importResultsExportErrorMsg');
    importResultsExportCopySuccessMsg = document.getElementById('importResultsExportCopySuccessMsg');
    importResultsExportCopyErrorMsg = document.getElementById('importResultsExportCopyErrorMsg');
    importResultsExportDownloadSuccessMsg = document.getElementById('importResultsExportDownloadSuccessMsg');
    importResultsExportDownloadErrorMsg = document.getElementById('importResultsExportDownloadErrorMsg');
    importResultsExportProgress = document.getElementById('importResultsExportProgress');
    importResultsExportProgressText = document.getElementById('importResultsExportProgressText');
    importResultsExportProgressBar = document.getElementById('importResultsExportProgressBar');
    importResultsExportProgressContainer = document.getElementById('importResultsExportProgressContainer');
    importResultsExportActions = document.getElementById('importResultsExportActions');
    importResultsExportCancelBtn = document.getElementById('importResultsExportCancelBtn');
    importResultsExportSubmitBtn = document.getElementById('importResultsExportSubmitBtn');
    importResultsExportDeleteBtn = document.getElementById('importResultsExportDeleteBtn');
    importResultsExportViewBtn = document.getElementById('importResultsExportViewBtn');
    importResultsExportRenameBtn = document.getElementById('importResultsExportRenameBtn');
    const importResultsExportRenameModalElem = document.getElementById('importResultsExportRenameModal');
    importResultsExportRenameModal = importResultsExportRenameModalElem ? new bootstrap.Modal(importResultsExportRenameModalElem) : null;
    importResultsExportRenameInput = document.getElementById('importResultsExportRenameInput');
    importResultsExportRenameSubmitBtn = document.getElementById('importResultsExportRenameSubmitBtn');
    importResultsExportRenameOriginalName = document.getElementById('importResultsExportRenameOriginalName');
    importResultsExportRenameNewName = document.getElementById('importResultsExportRenameNewName');
    importResultsExportRenameExtension = document.getElementById('importResultsExportRenameExtension');
    importResultsExportRenamePreview = document.getElementById('importResultsExportRenamePreview');
    importResultsExportRenameSku = document.getElementById('importResultsExportRenameSku');
    importResultsExportRenameProductName = document.getElementById('importResultsExportRenameProductName');
    importResultsExportRenameCancelBtn = document.getElementById('importResultsExportRenameCancelBtn');
    importResultsExportRenameSubmitBtn = document.getElementById('importResultsExportRenameSubmitBtn');
    importResultsExportRenameDeleteBtn = document.getElementById('importResultsExportRenameDeleteBtn');
    importResultsExportRenameViewBtn = document.getElementById('importResultsExportRenameViewBtn');
    importResultsExportRenameCloseBtn = document.getElementById('importResultsExportRenameCloseBtn');
    importResultsExportRenameSaveBtn = document.getElementById('importResultsExportRenameSaveBtn');
    importResultsExportRenameDiscardBtn = document.getElementById('importResultsExportRenameDiscardBtn');
    importResultsExportRenameResetBtn = document.getElementById('importResultsExportRenameResetBtn');
    importResultsExportRenameUndoBtn = document.getElementById('importResultsExportRenameUndoBtn');
    importResultsExportRenameRedoBtn = document.getElementById('importResultsExportRenameRedoBtn');
    importResultsExportRenameHistory = document.getElementById('importResultsExportRenameHistory');
    importResultsExportRenameHistoryList = document.getElementById('importResultsExportRenameHistoryList');
    importResultsExportRenameHistoryClearBtn = document.getElementById('importResultsExportRenameHistoryClearBtn');
    importResultsExportRenameHistoryUndoBtn = document.getElementById('importResultsExportRenameHistoryUndoBtn');
    importResultsExportRenameHistoryRedoBtn = document.getElementById('importResultsExportRenameHistoryRedoBtn');
    importResultsExportRenameHistoryResetBtn = document.getElementById('importResultsExportRenameHistoryResetBtn');
    
    loadSavedUsername();
    addLogoutAndClearBtn();
    checkAuth();
    updateRefreshTime();
    
    // 初始化移动端左侧菜单栏
    initMobileSidebar();
    
    // 重新绑定登录按钮事件
    if (loginBtn) {
        loginBtn.removeEventListener('click', login);
        loginBtn.addEventListener('click', login);
    }
    if (registerBtn) registerBtn.addEventListener('click', register);
    if (logoutBtn) logoutBtn.addEventListener('click', logout);
    
    // 侧边栏退出登录按钮
    if (sidebarLogoutBtn) {
        sidebarLogoutBtn.addEventListener('click', logout);
    }
    
    if (loginUsername) loginUsername.addEventListener('keypress', (e) => { if (e.key === 'Enter') login(); });
    if (loginPassword) loginPassword.addEventListener('keypress', (e) => { if (e.key === 'Enter') login(); });
    
    const scanSkuBtn = document.getElementById('scanSkuBtn');
    const scanSearchSkuBtn = document.getElementById('scanSearchSkuBtn');
    const scanNewSkuBtn = document.getElementById('scanNewSkuBtn');
    const scanLocationBtn = document.getElementById('scanLocationBtn');
    const stopScannerBtn = document.getElementById('stopScannerBtn');
    // scannerModalElem已在前面声明和初始化
    
    if (scanSkuBtn) {
        scanSkuBtn.addEventListener('click', () => { 
            startScanner((r) => handleScanResult(skuInput, r)); 
            if (scannerModal) scannerModal.show(); 
        });
    }
    if (scanSearchSkuBtn) {
        scanSearchSkuBtn.addEventListener('click', () => { 
            startScanner((r) => handleScanResult(searchSku, r)); 
            if (scannerModal) scannerModal.show(); 
        });
    }
    if (scanNewSkuBtn) {
        scanNewSkuBtn.addEventListener('click', () => { 
            startScanner((r) => handleScanResult(newSku, r)); 
            if (scannerModal) scannerModal.show(); 
        });
    }
    if (scanLocationBtn) {
        scanLocationBtn.addEventListener('click', () => {
            startScanner((r) => {
                // 对库位扫码结果进行A1-01-01格式处理
                let processedValue = r;
                if (r.length >= 6) {
                    // 尝试匹配类似A1-01-01的格式，如果匹配不到则使用原值
                    const match = r.match(/^([A-Za-z])(\d{1,2})[-_]?(\d{1,2})[-_]?(\d{1,2})$/);
                    if (match) {
                        processedValue = `${match[1]}${match[2]}-${match[3].padStart(2, '0')}-${match[4].padStart(2, '0')}`;
                    } else {
                        // 如果不是标准格式，尝试构造 A1-01-01 格式
                        const digits = r.replace(/[^A-Za-z0-9]/g, '');
                        if (digits.length >= 5) {
                            const letter = digits.charAt(0).toUpperCase();
                            const numPart = digits.substring(1);
                            if (numPart.length >= 4) {
                                processedValue = `${letter}${numPart.charAt(0)}-${numPart.charAt(1)}${numPart.charAt(2)}-${numPart.charAt(3)}${numPart.charAt(4) || '0'}`;
                            } else {
                                processedValue = `${letter}${numPart}`;
                            }
                        }
                    }
                }
                if (newLocation) newLocation.value = processedValue;
                showQuickToast(`已识别库位条形码: ${processedValue}`, "success");
            });
            if (scannerModal) scannerModal.show();
        });
    }
    if (stopScannerBtn) stopScannerBtn.addEventListener('click', () => { stopScanner(); if (scannerModal) scannerModal.hide(); });
    if (scannerModalElem) scannerModalElem.addEventListener('hidden.bs.modal', () => stopScanner());
    
    if (skuInput) {
        skuInput.addEventListener('input', function() { 
            if (skuInput.value.length === 5) {
                lookupProductWithExistingDates();
            }
        });
        skuInput.addEventListener('keypress', function(e) { 
            if (e.key === 'Enter' && skuInput.value.length === 5) {
                lookupProductWithExistingDates();
            }
        });
    }
    
    if (productionDate) {
        productionDate.addEventListener('change', function() {
            calculateDates();
            // 立即显示已有日期，不再等待
            showExistingDates();
            // 仅在表单数据完整时才启动自动保存，避免字段缺失时误报"缺少必要字段"
            const sku = skuInput.value.trim();
            const name = productName.value.trim();
            const shelf_life = shelfLife.value.trim();
            const reminder_days = reminderDays.value.trim();
            const production_date = productionDate.value;
            if (sku && name && shelf_life && reminder_days && production_date) {
                startAutoSaveTimer();
            }
        });
        // 添加input事件，在用户输入时也尝试显示已有日期
        productionDate.addEventListener('input', function() {
            // 延迟执行，避免频繁请求
            clearTimeout(window.productionDateInputTimer);
            window.productionDateInputTimer = setTimeout(() => {
                showExistingDates();
            }, 300);
        });
    }
    
	    if (saveBtn) {
	        saveBtn.addEventListener('click', () => {
	            cancelAutoSaveFlag = true;
	            if (autoSaveTimer) {
	                clearTimeout(autoSaveTimer);
	                autoSaveTimer = null;
	            }
	            const timerDiv = document.getElementById('autoSaveTimer');
	            if (timerDiv) timerDiv.style.display = 'none';
	            saveProductRecord(true);
	        });
	    }
	    
	    if (searchBtn) searchBtn.addEventListener('click', searchProduct);
    if (searchSku) searchSku.addEventListener('keypress', (e) => { if (e.key === 'Enter') searchProduct(); });
    if (addProductBtn) addProductBtn.addEventListener('click', addNewProduct);
    if (updateProductBtn) updateProductBtn.addEventListener('click', updateProduct);
    
    if (changePwdBtn) changePwdBtn.addEventListener('click', showChangePasswordModal);
    const confirmChangePwdBtn = document.getElementById('confirmChangePwdBtn');
    if (confirmChangePwdBtn) confirmChangePwdBtn.addEventListener('click', changePassword);
    
    // 新的修改密码标签页按钮
    if (changePasswordSubmitBtn) {
        changePasswordSubmitBtn.addEventListener('click', async () => {
            const currentPassword = document.getElementById('currentPassword').value.trim();
            const newPassword = document.getElementById('newPassword').value.trim();
            const confirmPassword = document.getElementById('confirmPassword').value.trim();
            
            if (!currentPassword || !newPassword || !confirmPassword) {
                showAlert('请填写所有密码字段', 'warning');
                return;
            }
            
            if (newPassword.length < 6) {
                showAlert('新密码至少需要6位字符', 'warning');
                return;
            }
            
            if (newPassword !== confirmPassword) {
                showAlert('两次输入的新密码不一致', 'warning');
                return;
            }
            
            if (currentPassword === newPassword) {
                showAlert('新密码不能与当前密码相同', 'warning');
                return;
            }
            
            try {
                changePasswordSubmitBtn.disabled = true;
                changePasswordSubmitBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> 修改中...';
                
                const response = await fetch(`${API_BASE_URL}/api/auth/change-password`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ currentPassword, newPassword })
                });
                
                const result = await response.json();
                
                if (!response.ok) throw new Error(result.error || '修改密码失败');
                
                showAlert('密码修改成功，请重新登录', 'success');
                
                // 清空表单
                document.getElementById('currentPassword').value = '';
                document.getElementById('newPassword').value = '';
                document.getElementById('confirmPassword').value = '';
                
                // 退出登录
                setTimeout(() => logout(), 1500);
                
            } catch (error) {
                showAlert(`修改密码失败: ${error.message}`, 'danger');
            } finally {
                changePasswordSubmitBtn.disabled = false;
                changePasswordSubmitBtn.innerHTML = '<i class="bi bi-check-circle"></i> 修改密码';
            }
        });
    }
    
    const exportUserDataBtn = document.getElementById('exportUserDataBtn');
    const importUserDataBtn = document.getElementById('importUserDataBtn');
    const resetUserDataBtn = document.getElementById('resetUserDataBtn');
    
    if (exportUserDataBtn) exportUserDataBtn.addEventListener('click', exportUserData);
    if (importUserDataBtn) importUserDataBtn.addEventListener('click', importUserData);
    if (resetUserDataBtn) resetUserDataBtn.addEventListener('click', showVerifyPasswordForReset);
    if (confirmVerifyResetBtn) confirmVerifyResetBtn.addEventListener('click', verifyAndResetData);
    
    if (expiringTab) expiringTab.addEventListener('click', () => { renderExpiringTable(true); });
    if (allTab) allTab.addEventListener('click', () => { renderAllTable(true); });
    if (clearanceTab) clearanceTab.addEventListener('click', () => { renderClearanceTable(true); });
    if (addTab) addTab.addEventListener('click', () => { renderProductDatabaseTable(false); });
    if (deletedTab) deletedTab.addEventListener('click', () => { renderDeletedList(); });
    if (adminTab) adminTab.addEventListener('click', () => { loadUsers(); loadAuthCodes(); loadLogs(); });
    
    // 绑定出清卡片分类筛选
    document.querySelectorAll('#clearanceSection .category-filter .btn').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('#clearanceSection .category-filter .btn').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            const category = this.getAttribute('data-category');
            filterClearanceByCategory(category);
        });
    });
    
    // 清空当天出清按钮事件已在下面统一处理
    
    document.querySelectorAll('[data-admin-tab]').forEach(btn => {
        btn.addEventListener('click', function() {
            document.querySelectorAll('[data-admin-tab]').forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            document.querySelectorAll('.admin-panel').forEach(panel => panel.style.display = 'none');
            const target = this.getAttribute('data-admin-tab');
            if (target === 'users') { const usersPanel = document.getElementById('admin-users'); if (usersPanel) usersPanel.style.display = 'block'; }
            else if (target === 'codes') { const codesPanel = document.getElementById('admin-codes'); if (codesPanel) codesPanel.style.display = 'block'; }
            else if (target === 'logs') { const logsPanel = document.getElementById('admin-logs'); if (logsPanel) logsPanel.style.display = 'block'; }
            else if (target === 'import-export') { const importExportPanel = document.getElementById('admin-import-export'); if (importExportPanel) importExportPanel.style.display = 'block'; }
        });
    });
    
    if (refreshUsersBtn) refreshUsersBtn.addEventListener('click', loadUsers);
    if (refreshCodesBtn) refreshCodesBtn.addEventListener('click', loadAuthCodes);
    if (refreshLogsBtn) refreshLogsBtn.addEventListener('click', loadLogs);
    if (generateCodeBtn) generateCodeBtn.addEventListener('click', generateAuthCode);
    if (confirmResetPasswordBtn) confirmResetPasswordBtn.addEventListener('click', confirmResetPassword);
    if (confirmValidityBtn) confirmValidityBtn.addEventListener('click', confirmValidity);
    if (confirmEditCodeBtn) confirmEditCodeBtn.addEventListener('click', confirmEditCode);
    if (exportDataBtn) exportDataBtn.addEventListener('click', exportData);
    if (importDataBtn) importDataBtn.addEventListener('click', importData);
    
    // 绑定登录和注册按钮事件
    // 重新绑定登录按钮事件
    if (loginBtn) {
        loginBtn.removeEventListener('click', login);
        loginBtn.addEventListener('click', login);
    }
    if (registerBtn) registerBtn.addEventListener('click', register);
    
    document.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key === 'r') {
            e.preventDefault();
            const activeTab = document.querySelector('.nav-link.active')?.id;
            dataCache.clear();
            if (activeTab === 'expiring-tab') renderExpiringTable(true);
            else if (activeTab === 'all-tab') renderAllTable(true);
            else if (activeTab === 'add-tab') renderProductDatabaseTable(true);
            else if (activeTab === 'clearance-tab') renderClearanceTable(true);
            showQuickToast('已强制刷新', 'info');
        }
        if (e.key === 'Escape' && document.activeElement === skuInput && skuInput) { skuInput.value = ''; clearForm(); }
    });

	    // 标签页切换事件监听器已在下面统一处理，无需重复绑定
    
    // 绑定清空当天出清按钮事件（确保只绑定一次）
    const clearTodayClearanceBtn = document.getElementById('clearTodayClearanceBtn');
    if (clearTodayClearanceBtn) {
        // 移除可能存在的旧事件监听器
        clearTodayClearanceBtn.removeEventListener('click', clearTodayClearance);
        clearTodayClearanceBtn.addEventListener('click', clearTodayClearance);
    }

    // 事件委托已经在bindClearanceCardButtons函数中统一处理，无需重复绑定

	    // 监听标签页切换事件，确保切换时刷新数据并立即更新菜单数字
	    document.querySelectorAll('.nav-link, .sidebar-menu-item').forEach(tab => {
	        tab.addEventListener('shown.bs.tab', async function (e) {
	            // 根据切换到的标签页，调用对应的渲染函数强制刷新
	            const target = e.target.getAttribute('data-bs-target') || e.target.getAttribute('data-target');
	            if (target) {
	                switch(target) {
	                    case '#expiring':
	                    case 'expiring':
	                        await renderExpiringTable(true); // 强制刷新
	                        // 确保在下一个事件循环更新菜单数字，此时DOM状态已更新
	                        setTimeout(() => { 
	                            // 临时标记当前页面类型，供updateMenuBadgeCounts使用
	                            window.currentActivePage = 'expiring';
	                            updateMenuBadgeCounts(); 
	                            // 清除临时标记
	                            setTimeout(() => { delete window.currentActivePage; }, 100);
	                        }, 10);
	                        break;
	                    case '#clearance':
	                    case 'clearance':
	                        await renderClearanceTable(true); // 强制刷新
	                        // 确保在下一个事件循环更新菜单数字，此时DOM状态已更新
	                        setTimeout(() => { 
	                            // 临时标记当前页面类型，供updateMenuBadgeCounts使用
	                            window.currentActivePage = 'clearance';
	                            updateMenuBadgeCounts(); 
	                            // 清除临时标记
	                            setTimeout(() => { delete window.currentActivePage; }, 100);
	                        }, 10);
	                        break;
	                    case '#recent-clearance':
	                    case 'recent-clearance':
	                        renderRecentClearanceTable(); // 待出清表没有强制刷新参数
	                        // 确保在下一个事件循环更新菜单数字，此时DOM状态已更新
	                        setTimeout(() => { 
	                            // 临时标记当前页面类型，供updateMenuBadgeCounts使用
	                            window.currentActivePage = 'recent-clearance';
	                            updateMenuBadgeCounts(); 
	                            // 清除临时标记
	                            setTimeout(() => { delete window.currentActivePage; }, 100);
	                        }, 10);
	                        break;
	case '#all':
                       case 'all':
                           await renderAllTable(true); // 强制刷新
                           // 确保在下一个事件循环更新菜单数字，此时DOM状态已更新
                           setTimeout(() => {
                               // 临时标记当前页面类型，供updateMenuBadgeCounts使用
                               window.currentActivePage = 'query'; // 商品查询页面
                               updateMenuBadgeCounts();
                               // 清除临时标记
                               setTimeout(() => { delete window.currentActivePage; }, 100);
                           }, 10);
                           break;
	case '#deleted':
                       case 'deleted':
                           renderDeletedList(); // 最近删除没有强制刷新参数
                           // 确保在下一个事件循环更新菜单数字，此时DOM状态已更新
                           setTimeout(() => {
                               // 临时标记当前页面类型，供updateMenuBadgeCounts使用
                               window.currentActivePage = 'deleted';
                               updateMenuBadgeCounts();
                               // 清除临时标记
                               setTimeout(() => { delete window.currentActivePage; }, 100);
                           }, 10);
                           break;
                       case '#add':
                       case 'add':
                           // 新增商品页面
                           setTimeout(() => {
                               // 临时标记当前页面类型，供updateMenuBadgeCounts使用
                               window.currentActivePage = 'add-product';
                               updateMenuBadgeCounts();
                               // 清除临时标记
                               setTimeout(() => { delete window.currentActivePage; }, 100);
                           }, 10);
                           break;
                       case '#data':
                       case 'data':
                           // 数据管理页面
                           setTimeout(() => {
                               // 临时标记当前页面类型，供updateMenuBadgeCounts使用
                               window.currentActivePage = 'data-management';
                               updateMenuBadgeCounts();
                               // 清除临时标记
                               setTimeout(() => { delete window.currentActivePage; }, 100);
                           }, 10);
                           break;
                       case '#changepwd':
                       case 'changepwd':
                           // 修改密码页面
                           setTimeout(() => {
                               // 临时标记当前页面类型，供updateMenuBadgeCounts使用
                               window.currentActivePage = 'change-password';
                               updateMenuBadgeCounts();
                               // 清除临时标记
                               setTimeout(() => { delete window.currentActivePage; }, 100);
                           }, 10);
                           break;
                   }
	            }
	        });
	    });
});

window.showDeleteConfirm = showDeleteConfirm;
window.showEditModal = showEditModal;
window.confirmDuplicate = confirmDuplicate;
window.cancelDuplicate = cancelDuplicate;
window.showImagePreview = showImagePreview;
window.showResetPasswordModal = showResetPasswordModal;
window.showValidityModal = showValidityModal;
window.editAuthCode = editAuthCode;
window.deleteUser = deleteUser;
window.copyToClipboard = copyToClipboard;
window.cancelAutoSave = cancelAutoSave;

// 更新各个标签页的计数显示
function updateMenuBadgeCounts() {
	// 临期商品计数 - 使用多重备用方案
	let expiringCount = 0;
	if (dataCache.expiring && dataCache.expiring.length > 0) {
		expiringCount = dataCache.expiring.length;
	} else {
		// 备用方案：使用DOM元素计数
		const expiringTableRows = document.querySelectorAll('#expiringTable tr').length - 1; // 减去表头行
		const expiringCards = document.querySelectorAll('#expiringCardsContainer .expiring-card').length;
		expiringCount = Math.max(expiringTableRows, expiringCards);
		// 如果DOM计数也为0，尝试从其他数据源获取
		if (expiringCount === 0 && dataCache.records) {
			// 从所有记录中筛选临期商品
			const today = new Date().toISOString().split('T')[0];
			expiringCount = dataCache.records.filter(record => {
				const expiryDate = new Date(record.production_date);
				expiryDate.setDate(expiryDate.getDate() + record.shelf_life);
				const daysRemaining = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
				return daysRemaining <= record.reminder_days && daysRemaining > 0;
			}).length;
		}
	}
	// 应用超过99显示99+的逻辑
	let expiringDisplayText = expiringCount > 99 ? '99+' : expiringCount.toString();
	const expiringBadge = document.getElementById('expiring-count-badge');
	if (expiringBadge) expiringBadge.textContent = expiringDisplayText;
	const mobileExpiringBadge = document.getElementById('mobile-expiring-count-badge');
	if (mobileExpiringBadge) mobileExpiringBadge.textContent = expiringDisplayText;

	// 建议出清计数 - 使用总数据量
	let clearanceCount = 0;
	// 尝试使用DataCache获取最新的建议出清数据，而不是依赖可能过时的clearanceAllData
	try {
		// 在UI上下文中，如果需要实时数据，可以从localStorage重新获取忽略列表
		const currentIgnoreList = JSON.parse(localStorage.getItem('clearanceIgnoreList') || '[]');
				
		// 使用多重数据源策略，确保获取到正确的建议出清数据
		let allRecords = dataCache.records;
				
		// 如果缓存中没有数据，尝试从其他来源获取
		if (!allRecords || allRecords.length === 0) {
			allRecords = window.productRecords || [];
		}
				
		if (!allRecords || allRecords.length === 0) {
			allRecords = [];
			// 尝试从dataCache的其他属性获取
			if (dataCache.expiring) {
				allRecords = [...dataCache.expiring];
			}
		}
				
		if (allRecords && allRecords.length > 0) {
			// 根据建议出清逻辑重新计算
			const today = new Date().toISOString().split('T')[0];
			const clearanceItems = allRecords.filter(record => {
				const remaining = record.remaining_days;
				const clearanceDays = calculateClearanceDays(record.shelf_life);
				// 建议出清逻辑：剩余天数 <= 建议出清天数 OR 剩余天数 <= 临期提醒天数
				const shouldShow = (remaining <= clearanceDays && clearanceDays > 0) || remaining <= (record.reminder_days || 0);
						
				// 过滤掉被忽略的商品
				const ignoreKey = `${record.sku}_${record.production_date}`;
				const isIgnored = currentIgnoreList.includes(ignoreKey);
						
				return shouldShow && !isIgnored;
			});
			clearanceCount = clearanceItems.length;
		}
	} catch (e) {
		console.warn('获取建议出清数据时出错，使用备用方案:', e);
	}
			
	// 如果上述方法失败，再尝试使用现有的数据源
	if (clearanceCount === 0) {
		if (clearanceAllData && clearanceAllData.length > 0) {
			clearanceCount = clearanceAllData.filter(item => {
				const ignoreKey = `${item.sku}_${item.production_date}`;
				return !clearanceIgnoreList.includes(ignoreKey);
			}).length;
		}
	}
			
	// 最后的备用方案：使用DOM元素计数
	if (clearanceCount === 0) {
		clearanceCount = document.querySelectorAll('#clearanceTable tr.clearance-row, #clearanceCardsContainer .expiring-card').length;
	}
			
	// 再次检查是否有数据，如果以上所有方法都失败，尝试直接从DataCache的getClearance方法获取
	if (clearanceCount === 0) {
		try {
			// 获取最新的建议出清数据
			const latestClearanceData = dataCache.clearance;
			if (latestClearanceData && Array.isArray(latestClearanceData)) {
				clearanceCount = latestClearanceData.length;
			}
		} catch (e) {
			console.warn('获取最新建议出清数据时出错:', e);
		}
	}
		
	// 最终备用方案：使用dataCache.getClearance()方法（如果可用）
	if (clearanceCount === 0) {
		try {
			// 如果有getClearance方法，直接使用它来获取最新的建议出清数据
			if (typeof dataCache.getClearance === 'function') {
				// 注意：这里不能使用await，所以我们使用同步方式检查
				const cachedClearanceData = dataCache.clearance;
				if (cachedClearanceData && Array.isArray(cachedClearanceData)) {
					clearanceCount = cachedClearanceData.filter(item => {
						const ignoreKey = `${item.sku}_${item.production_date}`;
						return !clearanceIgnoreList.includes(ignoreKey);
					}).length;
				}
			}
		} catch (e) {
			console.warn('使用getClearance方法获取数据时出错:', e);
		}
	}
		
	// 如果经过所有尝试，clearanceCount仍然为0，但clearanceAllData有数据，我们需要重新计算
	if (clearanceCount === 0 && clearanceAllData && clearanceAllData.length > 0) {
		try {
			const currentIgnoreList = JSON.parse(localStorage.getItem('clearanceIgnoreList') || '[]');
			clearanceCount = clearanceAllData.filter(item => {
				const ignoreKey = `${item.sku}_${item.production_date}`;
				return !currentIgnoreList.includes(ignoreKey);
			}).length;
		} catch (e) {
			console.warn('重新计算建议出清数据时出错:', e);
		}
	}
		
	// 应用超过99显示99+的逻辑
	let clearanceDisplayText = clearanceCount > 99 ? '99+' : clearanceCount.toString();
	const clearanceBadge = document.getElementById('clearance-count-badge');
	if (clearanceBadge) clearanceBadge.textContent = clearanceDisplayText;
	const mobileClearanceBadge = document.getElementById('mobile-clearance-count-badge');
	if (mobileClearanceBadge) mobileClearanceBadge.textContent = clearanceDisplayText;

    // 待出清表计数 - 应用超过99显示99+的逻辑
    let recentClearanceDisplayText = recentClearanceList.length > 99 ? '99+' : recentClearanceList.length.toString();
    const recentClearanceBadge = document.getElementById('recent-clearance-count-badge');
    if (recentClearanceBadge) recentClearanceBadge.textContent = recentClearanceDisplayText;
    const mobileRecentClearanceBadge = document.getElementById('mobile-recent-clearance-count-badge');
    if (mobileRecentClearanceBadge) mobileRecentClearanceBadge.textContent = recentClearanceDisplayText;

	// 所有商品计数 - 使用多重备用方案，确保计数准确
	let allCount = 0;
	if (allRecordsData && allRecordsData.length > 0) {
		allCount = allRecordsData.length;
	} else if (dataCache.records && dataCache.records.length > 0) {
		// 备用方案1：使用dataCache.records
		allCount = dataCache.records.length;
	} else {
		// 备用方案2：使用DOM元素计数
		const allTableRows = document.querySelectorAll('#allTable tr').length - 1; // 减去表头行
		const allCards = document.querySelectorAll('#allCards .expiring-card').length;
		allCount = Math.max(allTableRows, allCards);
		// 如果DOM计数也为0，尝试从其他数据源获取
		if (allCount === 0 && window.productRecords && window.productRecords.length > 0) {
			allCount = window.productRecords.length;
		}
	}
		
	// 应用超过99显示99+的逻辑
	let allDisplayText = allCount > 99 ? '99+' : allCount.toString();
	const allBadge = document.getElementById('all-count-badge');
	if (allBadge) allBadge.textContent = allDisplayText;
	const mobileAllBadge = document.getElementById('mobile-all-count-badge');
	if (mobileAllBadge) mobileAllBadge.textContent = allDisplayText;

    // 数据管理不需要显示数字，已移除相关badge

    // 最近删除计数 - 应用超过99显示99+的逻辑
    let deletedDisplayText = deletedItems.length > 99 ? '99+' : deletedItems.length.toString();
    const deletedBadge = document.getElementById('deleted-count-badge');
    if (deletedBadge) deletedBadge.textContent = deletedDisplayText;
    const mobileDeletedBadge = document.getElementById('mobile-deleted-count-badge');
    if (mobileDeletedBadge) mobileDeletedBadge.textContent = deletedDisplayText;

	    // 更新移动端菜单按钮的计数 - 显示当前激活标签页的计数
	    const menuBtnBadge = document.getElementById('menuBtnBadge');
	    const menuBtnIcon = document.querySelector('#mobileMenuBtn i'); // 获取菜单按钮图标
	    
	    if (menuBtnBadge && menuBtnIcon) {
	        let currentPageCount = 0;
	        
	        // 优先使用传入的当前页面类型，否则检查DOM中的活动标签页
	        const currentTabPage = window.currentActivePage || '';
	        
	        switch(currentTabPage) {
	            case 'expiring':
	                currentPageCount = expiringCount;
	                break;
	            case 'clearance':
	                currentPageCount = clearanceCount;
	                break;
	            case 'recent-clearance':
	                currentPageCount = recentClearanceList.length;
	                break;
	            case 'all':
	                currentPageCount = allCount;
	                break;
	            case 'deleted':
	                currentPageCount = deletedItems.length;
	                break;
	            default:
	                // 如果没有通过参数传入当前页面类型，则回退到DOM查询
	                const activeNavTab = document.querySelector('.nav-link.active');
	                const activeSidebarTab = document.querySelector('.sidebar-menu-item.active');
	                const activeTab = activeNavTab || activeSidebarTab;
	                
	                if (activeTab) {
	                    const target = activeTab.getAttribute('data-bs-target') || activeTab.getAttribute('data-target');
	                    if (target) {
	                        switch(target) {
	                            case '#expiring':
	                            case 'expiring':
	                                currentPageCount = expiringCount;
	                                break;
	                            case '#clearance':
	                            case 'clearance':
	                                currentPageCount = clearanceCount;
	                                break;
	                            case '#recent-clearance':
	                            case 'recent-clearance':
	                                currentPageCount = recentClearanceList.length;
	                                break;
	                            case '#all':
	                            case 'all':
	                                currentPageCount = allCount;
	                                break;
	                            case '#deleted':
	                            case 'deleted':
	                                currentPageCount = deletedItems.length;
	                                break;
	                            default:
	                                // 默认显示临期商品计数
	                                currentPageCount = expiringCount;
	                        }
	                    }
	                } else {
	                    // 如果没有激活的标签页，默认显示临期商品计数
	                    currentPageCount = expiringCount;
	                }
	        }
        
        // 数字超过99显示99+
        let displayText = '';
        if (currentPageCount > 99) {
            displayText = '99+';
        } else if (currentPageCount > 0) {
            displayText = currentPageCount.toString();
        }
        
        menuBtnBadge.textContent = displayText;
        
        // 根据用户要求：对于特定页面（商品查询、新增商品、数据管理、修改密码），始终显示菜单栏图标；其他页面根据数字显示
        const specificPages = ['query', 'add-product', 'data-management', 'change-password'];
        const currentTabPage2 = window.currentActivePage || '';
        
        if (specificPages.includes(currentTabPage2)) {
            // 特定页面：始终显示菜单栏图标，隐藏数字badge
            menuBtnIcon.classList.remove('d-none');
            menuBtnBadge.classList.add('d-none');
        } else {
            // 其他页面：有数字时隐藏图标显示数字，数字为0时显示图标隐藏数字
            if (currentPageCount > 0) {
                // 有数字：隐藏图标，显示数字badge
                menuBtnIcon.classList.add('d-none');
                menuBtnBadge.classList.remove('d-none');
            } else {
                // 数字为0：显示图标，隐藏数字badge
                menuBtnIcon.classList.remove('d-none');
                menuBtnBadge.classList.add('d-none');
            }
        }
    }
}
