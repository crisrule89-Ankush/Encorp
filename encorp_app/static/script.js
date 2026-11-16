function apiUrl(path) {
  const prefix = window.location.pathname.startsWith('/encorp/') ? '/encorp' : '';
  return `${prefix}${path}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

async function apiFetch(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.headers || {}) }
  });
  if (response.status === 401 && !document.getElementById('loginForm')) {
    window.location.replace('index.html');
  }
  return response;
}

function getSettings() {
  return JSON.parse(localStorage.getItem('encorpSettings') || '{}');
}

function setSettings(value) {
  localStorage.setItem('encorpSettings', JSON.stringify(value));
}

function getFields() {
  const stored = JSON.parse(localStorage.getItem('encorpFields') || 'null');
  if (stored && stored.length) {
    return stored.map((field) => ({ ...field, monthly: 0 }));
  }

  return [
    { id: 'basic', name: 'Basic Salary', type: 'earning', monthly: 0 },
    { id: 'hra', name: 'House Rent Allowance', type: 'earning', monthly: 0 },
    { id: 'medical', name: 'Medical Allowances', type: 'earning', monthly: 0 },
    { id: 'conveyance', name: 'Conveyance Allowance', type: 'earning', monthly: 0 },
    { id: 'education', name: 'Education', type: 'earning', monthly: 0 },
    { id: 'books', name: 'Books & Periodicals', type: 'earning', monthly: 0 },
    { id: 'attire', name: 'Attire Allowance', type: 'earning', monthly: 0 },
    { id: 'fuel', name: 'Fuel & Car Reimbursement', type: 'earning', monthly: 0 },
    { id: 'lta', name: 'L.T.A', type: 'earning', monthly: 0 },
    { id: 'bonus', name: 'Bonus 8.33%', type: 'earning', monthly: 0 },
    { id: 'otherAllow', name: 'Other Allowance', type: 'earning', monthly: 0 },
    { id: 'pf', name: 'P.F', type: 'deduction', monthly: 0 },
    { id: 'esic', name: 'E.S.I.C.', type: 'deduction', monthly: 0 },
    { id: 'pt', name: 'Professional Tax', type: 'deduction', monthly: 0 },
    { id: 'epf', name: 'Employer Contribution EPF', type: 'benefit', monthly: 0 },
    { id: 'mediclaim', name: 'Mediclaim', type: 'benefit', monthly: 0 },
    { id: 'gratuity', name: 'Gratuity', type: 'benefit', monthly: 0 },
    { id: 'benefitEsic', name: 'ESIC', type: 'benefit', monthly: 0 }
  ];
}

function saveFields(fields) {
  localStorage.setItem('encorpFields', JSON.stringify(fields));
}

function normalizeRecord(record) {
  let values = record.values;
  if (typeof values === 'string') {
    try {
      values = JSON.parse(values);
    } catch (error) {
      values = [];
    }
  }

  return {
    ...record,
    employeeName: record.employeeName || record.employee_name || '',
    employee_name: record.employee_name || record.employeeName || '',
    department: record.department || '',
    designation: record.designation || '',
    doj: record.doj || '',
    pan: record.pan || '',
    values: Array.isArray(values) ? values : []
  };
}

async function loadRecordsFromServer() {
  const response = await apiFetch('/api/records');
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Unable to load salary records from SQL Server.');
  }
  const records = await response.json();
  return Array.isArray(records) ? records.map(normalizeRecord) : [];
}

async function saveRecordToServer(record, mode) {
  const response = await apiFetch('/api/records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...record, mode })
  });
  if (!response.ok) {
    let message = 'Unable to save record';
    try {
      const error = await response.json();
      message = error.error || message;
    } catch (parseError) {
      // Keep the generic message when the server does not return JSON.
    }
    throw new Error(message);
  }
  return response.json();
}

async function loadRecordByPan(pan) {
  const response = await apiFetch(`/api/records?pan=${encodeURIComponent(pan)}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Unable to search the SQL Server.');
  }
  const record = await response.json();
  return record && record.pan ? normalizeRecord(record) : null;
}

async function deleteRecordFromServer(pan) {
  const response = await apiFetch(`/api/records?pan=${encodeURIComponent(pan)}`, { method: 'DELETE' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Unable to delete record from SQL Server.');
  }
  return response.json();
}

async function downloadExport(format) {
  const response = await apiFetch(`/api/records/export?format=${format}`);
  if (!response.ok) throw new Error('Unable to export records');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = format === 'excel' ? 'encorp-salary-records.xls' : 'encorp-salary-records.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function applyBranding() {
  const settings = getSettings();
  const root = document.documentElement;
  root.style.setProperty('--primary', settings.primaryColor || '#0f5d8f');
  root.style.setProperty('--primary-dark', settings.primaryDarkColor || '#0a3f5e');
  root.style.setProperty('--accent', settings.accentColor || '#f4b400');
  root.style.setProperty('--text', settings.textColor || '#162330');
  root.style.setProperty('--app-font', settings.fontFamily || 'Segoe UI');
  const companyName = document.getElementById('companyName');
  const companyTagline = document.getElementById('companyTagline');
  const pageBrand = document.getElementById('pageBrand');
  const logoPreview = document.getElementById('logoPreview');
  const headerLogo = document.getElementById('headerLogo');

  if (companyName) companyName.textContent = settings.companyName || 'Encorp Powertrans Pvt. Ltd.';
  if (companyTagline) companyTagline.textContent = settings.companyTagline || 'Employee Salary Portal';
  if (pageBrand) pageBrand.textContent = settings.companyName || 'Encorp Powertrans Pvt. Ltd.';

  const logoSize = Number(settings.logoSize || 72);
  const logoSrc = settings.logoData || 'encorp-logo.jpg';
  const applyLogoSize = (element) => {
    if (!element) return;
    element.src = logoSrc;
    element.style.width = `${logoSize}px`;
    element.style.height = `${logoSize}px`;
    element.style.objectFit = 'contain';
  };

  if (logoPreview) applyLogoSize(logoPreview);
  if (headerLogo) applyLogoSize(headerLogo);
}

async function protectPage() {
  const response = await apiFetch('/api/session');
  const status = response.ok ? await response.json() : { authenticated: false };
  if (!status.authenticated) {
    window.location.replace('index.html');
    throw new Error('Authentication required');
  }
}

function initThemeToggle() {
  const toggle = document.getElementById('themeToggle');
  if (!toggle) return;

  const savedTheme = localStorage.getItem('encorpTheme');
  if (savedTheme === 'dark') {
    document.body.classList.add('dark-mode');
    toggle.textContent = '☀️';
  }

  toggle.addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    const isDark = document.body.classList.contains('dark-mode');
    toggle.textContent = isDark ? '☀️' : '🌙';
    localStorage.setItem('encorpTheme', isDark ? 'dark' : 'light');
  });
}

function initSidebar() {
  const sidebar = document.getElementById('sidebar');
  const toggle = document.getElementById('sidebarToggle');
  if (!sidebar || !toggle) return;

  const storedState = localStorage.getItem('encorpSidebarCollapsed');
  if (storedState === 'true') {
    sidebar.classList.add('collapsed');
  }

  toggle.addEventListener('click', () => {
    sidebar.classList.toggle('collapsed');
    const nav = sidebar.querySelector('.sidebar-nav');
    if (nav) {
      nav.style.display = sidebar.classList.contains('collapsed') ? 'none' : 'grid';
    }
    localStorage.setItem('encorpSidebarCollapsed', sidebar.classList.contains('collapsed').toString());
  });

  const mediaQuery = window.matchMedia('(max-width: 900px)');
  const syncMobileNav = () => {
    const nav = sidebar.querySelector('.sidebar-nav');
    if (!nav) return;
    if (mediaQuery.matches) {
      nav.style.display = sidebar.classList.contains('collapsed') ? 'none' : 'grid';
    } else {
      nav.style.display = 'grid';
    }
  };

  mediaQuery.addEventListener('change', syncMobileNav);
  syncMobileNav();
}

function initLoginPage() {
  const loginForm = document.getElementById('loginForm');
  const loginMessage = document.getElementById('loginMessage');

  applyBranding();

  if (!loginForm) return;

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const username = document.getElementById('username').value.trim().toLowerCase();
    const password = document.getElementById('password').value;
    if (!username || !password) {
      loginMessage.textContent = 'Enter both your username and password.';
      return;
    }

    const response = await apiFetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      loginMessage.textContent = result.error || 'Unable to sign in. Please try again.';
      return;
    }
    loginMessage.textContent = 'Sign-in successful. Opening your dashboard…';
    window.location.assign('dashboard.html');
  });
}

async function downloadSalaryStructurePdf(payload) {
  const response = await apiFetch('/api/pdf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || 'Unable to create the offline A4 PDF.');
  }
  const blob = await response.blob();
  if (blob.type !== 'application/pdf') throw new Error('The server did not return a PDF file.');
  const fileName = `Salary_Structure_${String(payload.pan || 'salary-structure').replace(/[^a-zA-Z0-9_-]/g, '_')}.pdf`;
  const link = document.createElement('a');
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Keep the object URL alive briefly: revoking it immediately can cancel a
  // download in Chromium-based browsers before it reaches Downloads.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function initLogout() {
  const logoutLinks = Array.from(document.querySelectorAll('a[href="index.html"]'));
  logoutLinks.forEach((logoutLink) => {
    logoutLink.addEventListener('click', async (event) => {
      if (document.getElementById('loginForm')) return;
      event.preventDefault();
      await apiFetch('/api/logout', { method: 'POST' });
      window.location.assign('index.html');
    });
  });
}

async function updateDashboardInsights() {
  const records = await loadRecordsFromServer();
  const fields = getFields();
  const totals = { earning: 0, deduction: 0, benefit: 0 };

  records.forEach((record) => {
    record.values?.forEach((value) => {
      const field = fields.find((item) => item.id === value.id);
      const type = field?.type || value.type;
      const monthly = Number(value.monthly || 0);
      if (type === 'earning') totals.earning += monthly;
      if (type === 'deduction') totals.deduction += monthly;
      if (type === 'benefit') totals.benefit += monthly;
    });
  });

  const maxTotal = Math.max(totals.earning, totals.deduction, totals.benefit, 1);
  const formatCurrency = (value) => `₹ ${Number(value || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

  const setBarWidth = (barId, value) => {
    const bar = document.getElementById(barId);
    if (bar) {
      bar.style.width = `${Math.max(8, (value / maxTotal) * 100)}%`;
    }
  };

  setBarWidth('earningsBar', totals.earning);
  setBarWidth('deductionsBar', totals.deduction);
  setBarWidth('benefitsBar', totals.benefit);

  const earningsValue = document.getElementById('earningsValue');
  const deductionsValue = document.getElementById('deductionsValue');
  const benefitsValue = document.getElementById('benefitsValue');
  const overviewSummary = document.getElementById('overviewSummary');

  if (earningsValue) earningsValue.textContent = formatCurrency(totals.earning);
  if (deductionsValue) deductionsValue.textContent = formatCurrency(totals.deduction);
  if (benefitsValue) benefitsValue.textContent = formatCurrency(totals.benefit);
  if (overviewSummary) {
    const averageGross = records.length ? totals.earning / records.length : 0;
    overviewSummary.textContent = `${records.length} salary record${records.length === 1 ? '' : 's'} stored • average gross ${formatCurrency(averageGross)}`;
  }
}

// Chart.js Functions for Dashboard Analytics
function getMonthlyData(records) {
  const monthCounts = Array(12).fill(0);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  records.forEach(record => {
    if (record.doj) {
      try {
        const date = new Date(record.doj);
        const month = date.getMonth();
        monthCounts[month]++;
      } catch (e) {
        // Invalid date format, skip
      }
    }
  });

  return { labels: months, data: monthCounts };
}

function getQuarterlyData(records) {
  const quarterCounts = [0, 0, 0, 0];
  const quarters = ['Q1', 'Q2', 'Q3', 'Q4'];

  records.forEach(record => {
    if (record.doj) {
      try {
        const date = new Date(record.doj);
        const month = date.getMonth();
        const quarter = Math.floor(month / 3);
        quarterCounts[quarter]++;
      } catch (e) {
        // Invalid date format, skip
      }
    }
  });

  return { labels: quarters, data: quarterCounts };
}

function getYearlyData(records) {
  const yearMap = {};
  const years = [];
  let yearlyCounts = [];

  records.forEach(record => {
    if (record.doj) {
      try {
        const date = new Date(record.doj);
        const year = date.getFullYear();
        yearMap[year] = (yearMap[year] || 0) + 1;
      } catch (e) {
        // Invalid date format, skip
      }
    }
  });

  const sortedYears = Object.keys(yearMap).sort((a, b) => a - b);
  sortedYears.forEach(year => {
    years.push(year.toString());
    yearlyCounts.push(yearMap[year]);
  });

  return { labels: years.length ? years : ['No Data'], data: yearlyCounts.length ? yearlyCounts : [0] };
}

function createStatItem(label, value) {
  const item = document.createElement('div');
  item.className = 'stat-item';
  item.innerHTML = `<span class="stat-label">${label}</span><span class="stat-value">${value}</span>`;
  return item;
}

function renderMonthlyChart(records) {
  const canvas = document.getElementById('monthlyChart');
  if (!canvas) return;

  const { labels, data } = getMonthlyData(records);
  const totalRecords = data.reduce((a, b) => a + b, 0);
  const avgPerMonth = totalRecords > 0 ? (totalRecords / data.length).toFixed(0) : 0;

  const ctx = canvas.getContext('2d');
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Salary Records',
        data: data,
        backgroundColor: [
          '#0f5d8f', '#1680b8', '#1e9fd8', '#26bdf5',
          '#f4b400', '#ff9a76', '#ff7043', '#e94e1b',
          '#3ea4d8', '#1f77b4', '#2ca02c', '#d62728'
        ],
        borderRadius: 8,
        borderSkipped: false,
        hoverBackgroundColor: 'rgba(255,255,255,0.2)'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.8)',
          padding: 12,
          titleFont: { size: 12, weight: 'bold' },
          bodyFont: { size: 11 },
          borderColor: 'rgba(255,255,255,0.2)',
          borderWidth: 1,
          callbacks: {
            label: function(context) {
              return 'Records: ' + context.parsed.y;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { stepSize: Math.max(1, Math.ceil(Math.max(...data) / 5)) },
          grid: { color: 'rgba(0,0,0,0.05)' }
        },
        x: { grid: { display: false } }
      }
    }
  });

  // Update stats
  const statsContainer = document.getElementById('monthlyStats');
  if (statsContainer) {
    statsContainer.innerHTML = '';
    statsContainer.appendChild(createStatItem('Total Records', totalRecords));
    statsContainer.appendChild(createStatItem('Average/Month', avgPerMonth));
    statsContainer.appendChild(createStatItem('Peak Month', Math.max(...data)));
  }
}

function renderQuarterlyChart(records) {
  const canvas = document.getElementById('quarterlyChart');
  if (!canvas) return;

  const { labels, data } = getQuarterlyData(records);
  const totalRecords = data.reduce((a, b) => a + b, 0);

  const ctx = canvas.getContext('2d');
  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: data,
        backgroundColor: ['#0f5d8f', '#1680b8', '#f4b400', '#ff9a76'],
        borderColor: ['rgba(15,93,143,0.8)', 'rgba(22,128,184,0.8)', 'rgba(244,180,0,0.8)', 'rgba(255,154,118,0.8)'],
        borderWidth: 3,
        hoverOffset: 10
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'bottom',
          labels: { padding: 15, font: { size: 11, weight: '600' } }
        },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.8)',
          padding: 12,
          callbacks: {
            label: function(context) {
              const percentage = ((context.parsed / totalRecords) * 100).toFixed(1);
              return context.label + ': ' + context.parsed + ' (' + percentage + '%)';
            }
          }
        }
      }
    }
  });

  // Update stats
  const statsContainer = document.getElementById('quarterlyStats');
  if (statsContainer) {
    statsContainer.innerHTML = '';
    const maxQuarter = Math.max(...data);
    const maxQIndex = data.indexOf(maxQuarter);
    statsContainer.appendChild(createStatItem('Total Records', totalRecords));
    statsContainer.appendChild(createStatItem('Best Quarter', labels[maxQIndex]));
  }
}

function renderYearlyChart(records) {
  const canvas = document.getElementById('yearlyChart');
  if (!canvas) return;

  const { labels, data } = getYearlyData(records);
  const totalRecords = data.reduce((a, b) => a + b, 0);

  const ctx = canvas.getContext('2d');
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: 'Records per Year',
        data: data,
        borderColor: '#0f5d8f',
        backgroundColor: 'rgba(15, 93, 143, 0.1)',
        fill: true,
        tension: 0.4,
        pointBackgroundColor: '#0f5d8f',
        pointBorderColor: '#fff',
        pointBorderWidth: 2,
        pointRadius: 6,
        pointHoverRadius: 8,
        borderWidth: 3
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: true, labels: { font: { size: 11 } } },
        tooltip: {
          backgroundColor: 'rgba(0,0,0,0.8)',
          padding: 12,
          callbacks: {
            label: function(context) {
              return 'Records: ' + context.parsed.y;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { stepSize: Math.max(1, Math.ceil(Math.max(...data) / 5)) },
          grid: { color: 'rgba(0,0,0,0.05)' }
        },
        x: { grid: { display: false } }
      }
    }
  });

  // Update stats
  const statsContainer = document.getElementById('yearlyStats');
  if (statsContainer) {
    statsContainer.innerHTML = '';
    statsContainer.appendChild(createStatItem('Total Years', labels.length));
    statsContainer.appendChild(createStatItem('Total Records', totalRecords));
    const avgPerYear = totalRecords > 0 ? (totalRecords / labels.length).toFixed(0) : 0;
    statsContainer.appendChild(createStatItem('Average/Year', avgPerYear));
  }
}

function renderDashboardCharts(records) {
  if (records.length === 0) {
    // Show empty state for all charts
    ['monthlyStats', 'quarterlyStats', 'yearlyStats'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.innerHTML = '<div class="stat-item"><span class="stat-label">No Data</span><span class="stat-value">—</span></div>';
      }
    });
    return;
  }

  // Render all three charts
  try {
    renderMonthlyChart(records);
  } catch (e) {
    console.error('Error rendering monthly chart:', e);
  }

  try {
    renderQuarterlyChart(records);
  } catch (e) {
    console.error('Error rendering quarterly chart:', e);
  }

  try {
    renderYearlyChart(records);
  } catch (e) {
    console.error('Error rendering yearly chart:', e);
  }
}

async function initDashboardPage() {
  await protectPage();
  applyBranding();

  const records = await loadRecordsFromServer();
  const recordCount = records.length;
  const fieldCount = getFields().length;
  const recordCountEl = document.getElementById('recordCount');
  const fieldCountEl = document.getElementById('fieldCount');
  const companyNameEl = document.getElementById('dashboardCompanyName');

  if (recordCountEl) recordCountEl.textContent = recordCount;
  if (fieldCountEl) fieldCountEl.textContent = fieldCount;
  if (companyNameEl) companyNameEl.textContent = (getSettings().companyName || 'Encorp Powertrans Pvt. Ltd.');

  await updateDashboardInsights();
  
  // Initialize charts
  renderDashboardCharts(records);
}

async function initSettingsPage() {
  await protectPage();
  applyBranding();

  const settingsForm = document.getElementById('settingsForm');
  const settings = getSettings();
  const logoInput = document.getElementById('logoInput');
  const logoSizeInput = document.getElementById('logoSizeInput');
  const logoSizeValue = document.getElementById('logoSizeValue');
  const primaryColorInput = document.getElementById('primaryColorInput');
  const accentColorInput = document.getElementById('accentColorInput');
  const textColorInput = document.getElementById('textColorInput');
  const fontFamilyInput = document.getElementById('fontFamilyInput');
  const removeLogoBtn = document.getElementById('removeLogoBtn');
  const fieldForm = document.getElementById('fieldForm');
  const fieldList = document.getElementById('fieldList');
  const fieldNameInput = document.getElementById('fieldName');
  const fieldTypeInput = document.getElementById('fieldType');
  const fieldIdInput = document.getElementById('fieldId');
  const messageBox = document.getElementById('settingsMessage');

  document.getElementById('companyNameInput').value = settings.companyName || '';
  document.getElementById('companyTaglineInput').value = settings.companyTagline || '';
  document.getElementById('loginTitleInput').value = settings.loginTitle || '';
  if (logoSizeInput) {
    logoSizeInput.value = settings.logoSize || 72;
  }
  if (logoSizeValue) {
    logoSizeValue.textContent = `${settings.logoSize || 72}px`;
  }
  if (primaryColorInput) primaryColorInput.value = settings.primaryColor || '#0f5d8f';
  if (accentColorInput) accentColorInput.value = settings.accentColor || '#f4b400';
  if (textColorInput) textColorInput.value = settings.textColor || '#162330';
  if (fontFamilyInput) fontFamilyInput.value = settings.fontFamily || 'Segoe UI';

  if (settingsForm) {
    settingsForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const updated = {
        ...settings,
        companyName: document.getElementById('companyNameInput').value.trim() || 'Encorp Powertrans Pvt. Ltd.',
        companyTagline: document.getElementById('companyTaglineInput').value.trim() || 'Employee Salary Portal',
        loginTitle: document.getElementById('loginTitleInput').value.trim() || 'Employee Salary Portal',
        logoSize: Number(logoSizeInput?.value || 72),
        primaryColor: primaryColorInput?.value || '#0f5d8f',
        accentColor: accentColorInput?.value || '#f4b400',
        textColor: textColorInput?.value || '#162330',
        fontFamily: fontFamilyInput?.value || 'Segoe UI'
      };
      setSettings(updated);
      applyBranding();
      messageBox.textContent = 'Branding updated successfully.';
    });
  }

  if (logoInput) {
    logoInput.addEventListener('change', (event) => {
      const file = event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const updated = { ...settings, logoData: reader.result };
        setSettings(updated);
        applyBranding();
        messageBox.textContent = 'Logo updated successfully.';
      };
      reader.readAsDataURL(file);
    });
  }

  if (logoSizeInput) {
    logoSizeInput.addEventListener('input', () => {
      if (logoSizeValue) logoSizeValue.textContent = `${logoSizeInput.value}px`;
    });
  }

  if (removeLogoBtn) {
    removeLogoBtn.addEventListener('click', () => {
      const updated = { ...settings };
      delete updated.logoData;
      updated.logoSize = Number(logoSizeInput?.value || 72);
      setSettings(updated);
      applyBranding();
      messageBox.textContent = 'Logo removed. The default logo is now active.';
    });
  }

  function renderFields() {
    const fields = getFields();
    fieldList.innerHTML = '';
    fields.forEach((field) => {
      const row = document.createElement('div');
      row.className = 'result-item';
      row.innerHTML = `
        <div>
          <strong>${escapeHtml(field.name)}</strong>
          <div>${escapeHtml(field.type)}</div>
        </div>
        <div class="toolbar-group">
          <button type="button" data-action="edit" data-id="${field.id}">Edit</button>
          <button type="button" data-action="delete" data-id="${field.id}">Delete</button>
        </div>
      `;
      fieldList.appendChild(row);
    });
  }

  if (fieldForm) {
    fieldForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const fields = getFields();
      const name = fieldNameInput.value.trim();
      const type = fieldTypeInput.value;
      const id = fieldIdInput.value.trim() || name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
      if (!name) {
        messageBox.textContent = 'Field name is required.';
        return;
      }

      const existingIndex = fields.findIndex((field) => field.id === id);
      if (existingIndex >= 0) {
        fields[existingIndex] = { ...fields[existingIndex], name, type };
      } else {
        fields.push({ id, name, type, monthly: 0 });
      }
      saveFields(fields);
      fieldForm.reset();
      fieldIdInput.value = '';
      renderFields();
      messageBox.textContent = 'Salary field saved.';
    });
  }

  fieldList.addEventListener('click', (event) => {
    const target = event.target;
    if (target.tagName !== 'BUTTON') return;
    const { action, id } = target.dataset;
    const fields = getFields();
    if (action === 'delete') {
      const filtered = fields.filter((field) => field.id !== id);
      saveFields(filtered);
      renderFields();
      messageBox.textContent = 'Field deleted.';
    } else if (action === 'edit') {
      const field = fields.find((item) => item.id === id);
      if (field) {
        fieldNameInput.value = field.name;
        fieldTypeInput.value = field.type;
        fieldIdInput.value = field.id;
      }
    }
  });

  renderFields();
}

function renderPayslipPreview() {
  const previewCard = document.getElementById('payslipPreview');
  if (!previewCard) return;

  const employeeName = document.getElementById('employeeName').value.trim() || 'Employee';
  const department = document.getElementById('department').value.trim() || 'Department';
  const designation = document.getElementById('designation').value.trim() || 'Designation';
  const doj = document.getElementById('doj').value || 'Not provided';
  const previewEmployeeName = document.getElementById('previewEmployeeName');
  const previewDepartment = document.getElementById('previewDepartment');
  const previewDesignation = document.getElementById('previewDesignation');
  const previewDoj = document.getElementById('previewDoj');
  const subtitle = document.getElementById('payslipPreviewSubtitle');
  const breakdownBody = document.getElementById('payslipBreakdownBody');
  const previewCompanyName = document.getElementById('previewCompanyName');
  const previewCompanyTagline = document.getElementById('previewCompanyTagline');
  const previewLogo = document.getElementById('previewLogo');
  const previewPan = document.getElementById('previewPan');
  const previewNetPay = document.getElementById('previewNetPay');
  const previewGrossMonthly = document.getElementById('previewGrossMonthly');
  const previewGrossYearly = document.getElementById('previewGrossYearly');
  const previewDeductionMonthly = document.getElementById('previewDeductionMonthly');
  const previewDeductionYearly = document.getElementById('previewDeductionYearly');
  const previewNetMonthly = document.getElementById('previewNetMonthly');
  const previewNetYearly = document.getElementById('previewNetYearly');
  const payslipSlipDate = document.getElementById('payslipSlipDate');
  const payslipPayPeriod = document.getElementById('payslipPayPeriod');
  const settings = getSettings();

  if (previewEmployeeName) previewEmployeeName.textContent = employeeName;
  if (previewDepartment) previewDepartment.textContent = department;
  if (previewDesignation) previewDesignation.textContent = designation;
  if (previewDoj) previewDoj.textContent = doj;
  if (previewPan) previewPan.textContent = document.getElementById('panNumber').value.trim() || 'N/A';
  if (subtitle) subtitle.textContent = `${employeeName} • ${department}`;
  if (previewCompanyName) previewCompanyName.textContent = settings.companyName || 'Encorp Powertrans Pvt. Ltd.';
  if (previewCompanyTagline) previewCompanyTagline.textContent = settings.companyTagline || 'Compensation Offer';
  if (previewLogo) previewLogo.src = settings.logoData || 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"%3E%3Crect width="120" height="120" rx="24" fill="%230f5d8f"/%3E%3Cpath d="M35 82V48h12v34H35Zm18 0V38h12v44H53Zm18 0V28h12v54H71Z" fill="white"/%3E%3C/svg%3E';
  const offerGreeting = document.getElementById('offerGreeting');
  if (offerGreeting) offerGreeting.textContent = `Dear ${employeeName}, this salary structure offer provides a detailed breakdown of your proposed compensation for the role of ${designation}.`;
  if (payslipSlipDate) payslipSlipDate.textContent = `Offer Date: ${new Date().toLocaleDateString('en-GB')}`;
  if (payslipPayPeriod) payslipPayPeriod.textContent = `Valid Until: ${new Date().toLocaleString('default', { month: 'long', year: 'numeric' })}`;

  const fields = getFields();
  let totalEarnings = 0;
  let totalDeductions = 0;
  let totalBenefits = 0;

  const rows = fields.map((field) => {
    const input = document.querySelector(`[data-field-id="${field.id}"]`);
    const monthly = Number(input?.value || 0);
    const yearly = monthly * 12;
    const entryType = field.type === 'earning' ? 'Earning' : field.type === 'deduction' ? 'Deduction' : 'Benefit';

    if (field.type === 'earning') totalEarnings += monthly;
    if (field.type === 'deduction') totalDeductions += monthly;
    if (field.type === 'benefit') totalBenefits += monthly;

    return `
      <tr>
        <td>${escapeHtml(field.name)}</td>
        <td><span class="type-pill">${entryType}</span></td>
        <td>₹ ${monthly.toFixed(2)}</td>
        <td>₹ ${yearly.toFixed(2)}</td>
      </tr>
    `;
  }).join('');

  const netMonthly = totalEarnings - totalDeductions + totalBenefits;
  const netYearly = netMonthly * 12;

  if (breakdownBody) breakdownBody.innerHTML = rows;
  if (previewGrossMonthly) previewGrossMonthly.textContent = `₹ ${totalEarnings.toFixed(2)}`;
  if (previewGrossYearly) previewGrossYearly.textContent = `₹ ${(totalEarnings * 12).toFixed(2)}`;
  if (previewDeductionMonthly) previewDeductionMonthly.textContent = `₹ ${totalDeductions.toFixed(2)}`;
  if (previewDeductionYearly) previewDeductionYearly.textContent = `₹ ${(totalDeductions * 12).toFixed(2)}`;
  if (previewNetMonthly) previewNetMonthly.textContent = `₹ ${netMonthly.toFixed(2)}`;
  if (previewNetYearly) previewNetYearly.textContent = `₹ ${netYearly.toFixed(2)}`;
  if (previewNetPay) previewNetPay.textContent = `₹ ${netMonthly.toFixed(2)}`;
}

function renderSalarySections() {
  const container = document.getElementById('salarySections');
  if (!container) return;

  const fields = getFields();
  const earningFields = fields.filter((field) => field.type === 'earning');
  const deductionFields = fields.filter((field) => field.type === 'deduction');
  const benefitFields = fields.filter((field) => field.type === 'benefit');

  const sections = [
    { title: 'Salary Breakup', fields: earningFields, type: 'earning' },
    { title: 'Deductions', fields: deductionFields, type: 'deduction' },
    { title: 'Other Benefits', fields: benefitFields, type: 'benefit' }
  ];

  container.innerHTML = sections.map((section) => {
    const rows = section.fields.map((field) => `
      <tr>
        <td>${field.name}</td>
        <td><input class="amount-input" data-field-id="${field.id}" data-group="${section.type}" type="number" value="${field.monthly || 0}" /></td>
        <td><input class="yearly-value" data-yearly="${field.id}" type="text" value="0" readonly /></td>
        <td><input class="percent-value" data-percent="${field.id}" type="text" value="0%" readonly /></td>
      </tr>
    `).join('');

    const totalLabel = section.type === 'earning' ? 'Gross Salary Payable' : section.type === 'deduction' ? 'Total' : 'Total';
    const totalId = section.type === 'earning' ? 'grossMonthly' : section.type === 'deduction' ? 'deductionMonthly' : 'benefitMonthly';
    const totalYearlyId = section.type === 'earning' ? 'grossYearly' : section.type === 'deduction' ? 'deductionYearly' : 'benefitYearly';
    const extraRow = section.type === 'deduction' ? `
      <tr>
        <td>Cash in Hand</td>
        <td><input id="cashInHand" type="text" value="0" readonly /></td>
        <td><input id="cashInHandYearly" type="text" value="0" readonly /></td>
        <td><input type="text" value="-" readonly /></td>
      </tr>
    ` : '';

    return `
      <section class="table-card">
        <h2>${section.title}</h2>
        <div class="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Particulars</th>
                <th>Monthly</th>
                <th>Yearly</th>
                <th>Percentage</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
              <tr class="total-row">
                <td>${totalLabel}</td>
                <td><input id="${totalId}" type="text" value="0" readonly /></td>
                <td><input id="${totalYearlyId}" type="text" value="0" readonly /></td>
                <td><input type="text" value="100%" readonly /></td>
              </tr>
              ${extraRow}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }).join('');
}

async function initSalaryPage() {
  await protectPage();
  applyBranding();
  renderSalarySections();

  const recordStatus = document.getElementById('recordStatus');
  const panInput = document.getElementById('panNumber');
  const saveBtn = document.getElementById('saveRecordBtn');
  const updateBtn = document.getElementById('updateRecordBtn');
  const deleteBtn = document.getElementById('deleteRecordBtn');
  const searchBtn = document.getElementById('searchRecordBtn');
  const pdfBtn = document.getElementById('pdfBtn');
  const csvBtn = document.getElementById('csvBtn');
  const excelBtn = document.getElementById('excelBtn');
  const employeeNameInput = document.getElementById('employeeName');
  const departmentInput = document.getElementById('department');
  const designationInput = document.getElementById('designation');
  const dojInput = document.getElementById('doj');

  function loadRecordIntoForm(record) {
    const normalizedRecord = normalizeRecord(record);
    panInput.value = normalizedRecord.pan;
    employeeNameInput.value = normalizedRecord.employeeName || '';
    departmentInput.value = normalizedRecord.department || '';
    designationInput.value = normalizedRecord.designation || '';
    dojInput.value = normalizedRecord.doj || '';

    const fields = getFields();
    fields.forEach((field) => {
      const input = document.querySelector(`[data-field-id="${field.id}"]`);
      const savedValue = normalizedRecord.values?.find((item) => item.id === field.id);
      if (input) input.value = savedValue?.monthly || 0;
    });
    updateSummary();
  }

  function collectValues() {
    const fields = getFields();
    return fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      monthly: Number(document.querySelector(`[data-field-id="${field.id}"]`)?.value || 0)
    }));
  }

  function updateSummary() {
    const monthlyInputs = Array.from(document.querySelectorAll('.amount-input'));
    const earningInputs = monthlyInputs.filter((input) => input.dataset.group === 'earning');
    const deductionInputs = monthlyInputs.filter((input) => input.dataset.group === 'deduction');
    const benefitInputs = monthlyInputs.filter((input) => input.dataset.group === 'benefit');

    const grossMonthly = earningInputs.reduce((sum, input) => sum + Number(input.value || 0), 0);
    const grossYearly = grossMonthly * 12;
    const deductionMonthly = deductionInputs.reduce((sum, input) => sum + Number(input.value || 0), 0);
    const deductionYearly = deductionMonthly * 12;
    const cashInHand = grossMonthly - deductionMonthly;
    const cashInHandYearly = grossYearly - deductionYearly;
    const benefitMonthly = benefitInputs.reduce((sum, input) => sum + Number(input.value || 0), 0);
    const benefitYearly = benefitMonthly * 12;
    const ctc = grossYearly + benefitYearly;

    const summaryGrossMonthly = document.getElementById('summaryGrossMonthly');
    const summaryDeductionMonthly = document.getElementById('summaryDeductionMonthly');
    const summaryCashInHand = document.getElementById('summaryCashInHand');
    const summaryBenefits = document.getElementById('summaryBenefits');

    document.querySelectorAll('.yearly-value').forEach((input) => {
      const fieldId = input.dataset.yearly;
      const monthlyInput = document.querySelector(`[data-field-id="${fieldId}"]`);
      input.value = `${Number(monthlyInput?.value || 0) * 12}`;
    });

    document.querySelectorAll('.percent-value').forEach((input) => {
      const fieldId = input.dataset.percent;
      const monthlyInput = document.querySelector(`[data-field-id="${fieldId}"]`);
      const value = Number(monthlyInput?.value || 0);
      const percent = grossMonthly === 0 ? '0.00%' : `${((value / grossMonthly) * 100).toFixed(2)}%`;
      input.value = percent;
    });

    const grossMonthlyField = document.getElementById('grossMonthly');
    const grossYearlyField = document.getElementById('grossYearly');
    const deductionMonthlyField = document.getElementById('deductionMonthly');
    const deductionYearlyField = document.getElementById('deductionYearly');
    const cashInHandField = document.getElementById('cashInHand');
    const cashInHandYearlyField = document.getElementById('cashInHandYearly');
    const benefitMonthlyField = document.getElementById('benefitMonthly');
    const benefitYearlyField = document.getElementById('benefitYearly');
    const ctcValue = document.getElementById('ctcValue');

    if (grossMonthlyField) grossMonthlyField.value = grossMonthly.toFixed(2);
    if (grossYearlyField) grossYearlyField.value = grossYearly.toFixed(2);
    if (deductionMonthlyField) deductionMonthlyField.value = deductionMonthly.toFixed(2);
    if (deductionYearlyField) deductionYearlyField.value = deductionYearly.toFixed(2);
    if (cashInHandField) cashInHandField.value = cashInHand.toFixed(2);
    if (cashInHandYearlyField) cashInHandYearlyField.value = cashInHandYearly.toFixed(2);
    if (benefitMonthlyField) benefitMonthlyField.value = benefitMonthly.toFixed(2);
    if (benefitYearlyField) benefitYearlyField.value = benefitYearly.toFixed(2);
    if (ctcValue) ctcValue.textContent = `₹ ${ctc.toFixed(2)}`;
    if (summaryGrossMonthly) summaryGrossMonthly.textContent = `₹ ${grossMonthly.toFixed(2)}`;
    if (summaryDeductionMonthly) summaryDeductionMonthly.textContent = `₹ ${deductionMonthly.toFixed(2)}`;
    if (summaryCashInHand) summaryCashInHand.textContent = `₹ ${cashInHand.toFixed(2)}`;
    if (summaryBenefits) summaryBenefits.textContent = `₹ ${benefitMonthly.toFixed(2)}`;

    renderPayslipPreview();
  }

  document.addEventListener('input', (event) => {
    if (event.target.classList.contains('amount-input')) {
      updateSummary();
    }
  });

  saveBtn.addEventListener('click', async () => {
    const pan = panInput.value.trim();
    if (!pan) {
      recordStatus.textContent = 'PAN number is required.';
      return;
    }
    const newRecord = {
      pan,
      employee_name: employeeNameInput.value.trim(),
      department: departmentInput.value.trim(),
      designation: designationInput.value.trim(),
      doj: dojInput.value,
      values: JSON.stringify(collectValues())
    };
    try {
      await saveRecordToServer(newRecord, 'create');
      recordStatus.textContent = `Saved record for ${pan}.`;
    } catch (error) {
      recordStatus.textContent = error.message || 'Unable to save record to SQL Server.';
    }
  });

  updateBtn.addEventListener('click', async () => {
    const pan = panInput.value.trim();
    if (!pan) {
      recordStatus.textContent = 'Enter PAN to update.';
      return;
    }
    try {
      const updated = {
        pan,
        employee_name: employeeNameInput.value.trim(),
        department: departmentInput.value.trim(),
        designation: designationInput.value.trim(),
        doj: dojInput.value,
        values: JSON.stringify(collectValues())
      };
      await saveRecordToServer(updated, 'update');
      recordStatus.textContent = `Updated record for ${pan}.`;
    } catch (error) {
      recordStatus.textContent = error.message || 'Unable to update record.';
    }
  });

  deleteBtn.addEventListener('click', async () => {
    const pan = panInput.value.trim();
    if (!pan) {
      recordStatus.textContent = 'Enter PAN to delete.';
      return;
    }
    try {
      await deleteRecordFromServer(pan);
      employeeNameInput.value = ''; departmentInput.value = ''; designationInput.value = ''; dojInput.value = ''; panInput.value = '';
      document.querySelectorAll('.amount-input').forEach((input) => { input.value = '0'; });
      updateSummary();
      recordStatus.textContent = `Deleted record for ${pan}.`;
    } catch (error) {
      recordStatus.textContent = error.message || 'Unable to delete record.';
    }
  });

  searchBtn.addEventListener('click', () => {
    const pan = panInput.value.trim();
    window.location.href = pan
      ? `search.html?pan=${encodeURIComponent(pan.toUpperCase())}`
      : 'search.html';
  });

  pdfBtn.addEventListener('click', async () => {
    renderPayslipPreview();
    pdfBtn.disabled = true;
    pdfBtn.textContent = 'Creating A4 PDF…';
    recordStatus.textContent = 'Creating the A4 salary structure PDF…';
    const settings = getSettings();
    const now = new Date();
    const payload = {
      pan: panInput.value.trim() || 'salary-structure',
      employee_name: employeeNameInput.value.trim(),
      department: departmentInput.value.trim(),
      designation: designationInput.value.trim(),
      doj: dojInput.value,
      values: collectValues(),
      company_name: settings.companyName || 'Encorp Powertrans Pvt. Ltd.',
      company_tagline: settings.companyTagline || 'Employee Salary Portal',
      logo_data: settings.logoData || '',
      company_address: 'Payroll & HR Department',
      offer_date: now.toLocaleDateString('en-GB'),
      valid_until: now.toLocaleString('en-US', { month: 'long', year: 'numeric' })
    };
    try {
      await downloadSalaryStructurePdf(payload);
      recordStatus.textContent = `A4 PDF downloaded for ${payload.pan}.`;
    } catch (error) {
      recordStatus.textContent = error.message || 'Unable to create the A4 PDF.';
    } finally {
      pdfBtn.disabled = false;
      pdfBtn.textContent = 'Save as PDF';
    }
  });

  csvBtn.addEventListener('click', async () => {
    try {
      await downloadExport('csv');
      recordStatus.textContent = 'Exported CSV from SQL Server.';
    } catch (error) {
      recordStatus.textContent = error.message || 'CSV export failed.';
    }
  });

  excelBtn.addEventListener('click', async () => {
    try {
      await downloadExport('excel');
      recordStatus.textContent = 'Exported Excel from SQL Server.';
    } catch (error) {
      recordStatus.textContent = error.message || 'Excel export failed.';
    }
  });

  const urlParams = new URLSearchParams(window.location.search);
  const panFromUrl = urlParams.get('pan');
  if (panFromUrl) {
    const record = await loadRecordByPan(panFromUrl);
    if (record) {
      loadRecordIntoForm(record);
      recordStatus.textContent = `Loaded record for ${record.pan}`;
      return;
    }
    recordStatus.textContent = `No record found for ${panFromUrl.toUpperCase()}.`;
  }

  panInput.value = '';
  employeeNameInput.value = '';
  departmentInput.value = '';
  designationInput.value = '';
  dojInput.value = '';
  document.querySelectorAll('.amount-input').forEach((input) => {
    input.value = '0';
  });
  updateSummary();
}

async function initSearchPage() {
  await protectPage();
  applyBranding();

  const searchInput = document.getElementById('searchPan');
  const results = document.getElementById('searchResults');
  const searchButton = document.getElementById('searchButton');

  function renderResults(records) {
    if (!records.length) {
      results.innerHTML = '<div class="result-item">No records found.</div>';
      return;
    }

    results.innerHTML = records.map((record) => `
      <div class="result-item">
        <div>
          <strong>${escapeHtml(record.employeeName || 'N/A')}</strong>
          <div>PAN: ${escapeHtml(record.pan)}</div>
          <div>${escapeHtml(record.department || '')} ${record.designation ? '• ' + escapeHtml(record.designation) : ''}</div>
        </div>
        <a class="nav-link" href="salary.html?pan=${encodeURIComponent(record.pan)}">Open</a>
      </div>
    `).join('');
  }

  searchButton.addEventListener('click', async () => {
    try {
      const query = searchInput.value.trim();
      if (!query) {
        renderResults(await loadRecordsFromServer());
        return;
      }
      const record = await loadRecordByPan(query);
      renderResults(record ? [record] : []);
    } catch (error) {
      results.innerHTML = `<div class="result-item">${error.message || 'Unable to search SQL Server.'}</div>`;
    }
  });

  const urlParams = new URLSearchParams(window.location.search);
  const panFromUrl = urlParams.get('pan');
  if (panFromUrl) {
    searchInput.value = panFromUrl;
    try {
      const record = await loadRecordByPan(panFromUrl);
      renderResults(record ? [record] : []);
    } catch (error) {
      results.innerHTML = `<div class="result-item">${error.message || 'Unable to search SQL Server.'}</div>`;
    }
  }
}

function getVisualPdfGenerator() {
  if (typeof window.html2pdf === 'function') return Promise.resolve(window.html2pdf);

  return new Promise((resolve) => {
    const existingLoader = document.getElementById('localPdfRendererLoader');
    if (existingLoader) {
      // A failed request can leave an earlier loader in the page.  Remove it so
      // the retry below can use the packaged file instead of waiting forever.
      if (existingLoader.dataset.failed === 'true' || document.readyState === 'complete') {
        existingLoader.remove();
      } else {
        existingLoader.addEventListener('load', () => resolve(window.html2pdf), { once: true });
        existingLoader.addEventListener('error', () => {
          existingLoader.dataset.failed = 'true';
          resolve(null);
        }, { once: true });
        return;
      }
    }

    const loader = document.createElement('script');
    loader.id = 'localPdfRendererLoader';
    loader.src = `vendor/html2pdf.bundle.min.js?reload=${Date.now()}`;
    loader.onload = () => resolve(window.html2pdf);
    loader.onerror = () => {
      loader.dataset.failed = 'true';
      resolve(null);
    };
    document.head.appendChild(loader);
  });
}

function downloadFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

initThemeToggle();
initSidebar();
initLogout();

if (document.getElementById('loginForm')) {
  initLoginPage();
} else if (document.getElementById('salarySections')) {
  initSalaryPage().catch(console.error);
} else if (document.getElementById('settingsForm')) {
  initSettingsPage().catch(console.error);
} else if (document.getElementById('searchResults')) {
  initSearchPage().catch(console.error);
} else if (document.getElementById('recordCount')) {
  initDashboardPage().catch(console.error);
} else {
  applyBranding();
}
