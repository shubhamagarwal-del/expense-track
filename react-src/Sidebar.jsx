// Shared sidebar for all React pages (check-in, location-request, checkins).
// Mirrors the vanilla dashboard sidebar EXACTLY — same links, ids and
// display:none defaults — so window.populateSidebar(profile) reveals the same
// role-based menu (Manage Users, Payment Register, Advances, Site Check-ins,
// Create User, …) on every page. Pass `active` = the current page's href to
// highlight it. Keep this in sync with the dashboard.html sidebar.
import React from 'react';

const Icon = ({ d, d2 }) => (
  <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
    <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    {d2 && <path strokeLinecap="round" strokeLinejoin="round" d={d2} />}
  </svg>
);

const ICONS = {
  home: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  plans: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  plus: 'M12 4v16m8-8H4',
  pinA: 'M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z',
  pinB: 'M15 11a3 3 0 11-6 0 3 3 0 016 0z',
  bell: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
  user: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  bank: 'M3 10h18M5 6h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2zM7 15h2',
  addUser: 'M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z',
  users: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
  pay: 'M12 8v8m-4-5h8M5 6h14a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2z',
  help: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  logout: 'M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1',
};

export default function Sidebar({ active }) {
  const cls = (href) => 'sidebar-link' + (active === href ? ' active' : '');
  const hide = { display: 'none' };
  return (
    <>
      <div className="sidebar-overlay" id="sidebar-overlay" onClick={() => window.closeSidebar()}></div>
      <nav className="sidebar" id="sidebar">
        <div className="sidebar-logo">
          <div className="logo-icon"><img src="/icon-192.png" alt="ExpenseTrack" /></div>
          <span className="logo-text">ExpenseTrack</span>
        </div>
        <div className="sidebar-nav">
          <p className="sidebar-nav-label">Menu</p>

          <a href="dashboard.html" className={cls('dashboard.html')}><Icon d={ICONS.home} />Dashboard</a>

          <a href="plans.html" className="sidebar-link" id="sb-plans-link" style={hide}><Icon d={ICONS.plans} />Work Plans</a>

          <a href="add-expense.html" className={cls('add-expense.html')} id="sb-add-link" style={hide}><Icon d={ICONS.plus} />Add Expense</a>

          <a href="checkin-react.html" className={cls('checkin-react.html')} id="sb-checkin-link" style={hide}><Icon d={ICONS.pinA} d2={ICONS.pinB} />Site Check-in</a>

          <a href="location-request-react.html" className={cls('location-request-react.html')} id="sb-location-request-link" style={hide}>
            <Icon d={ICONS.bell} />Location Request
            <span id="lr-badge" style={{ display: 'none', marginLeft: 'auto', background: '#dc2626', color: '#fff', borderRadius: 999, minWidth: 18, height: 18, fontSize: '.68rem', fontWeight: 800, alignItems: 'center', justifyContent: 'center', padding: '0 5px' }}></span>
          </a>

          <a href="profile.html" className={cls('profile.html')} id="sb-profile-link"><Icon d={ICONS.user} />My Profile</a>

          <a href="profile.html#bank-card" className="sidebar-link" id="sb-bank-link"><Icon d={ICONS.bank} />Bank Details</a>

          <a href="create-user.html" className="sidebar-link" id="sb-create-user-link" style={hide}><Icon d={ICONS.addUser} />Create User</a>

          <a href="manage-users.html" className="sidebar-link" id="sb-manage-users-link" style={hide}><Icon d={ICONS.users} />Manage Users</a>

          <a href="payment-register.html" className="sidebar-link" id="sb-payment-register-link" style={hide}><Icon d={ICONS.pay} />Payment Register</a>

          <a href="advances.html" className="sidebar-link" id="sb-advances-link" style={hide}><Icon d={ICONS.plus} />Advances</a>

          <a href="checkins-react.html" className={cls('checkins-react.html')} id="sb-checkins-link" style={hide}><Icon d={ICONS.pinA} d2={ICONS.pinB} />Site Check-ins</a>

          <a href="help.html" className="sidebar-link" id="sb-help-link"><Icon d={ICONS.help} />Help Center</a>

          <a href="#" onClick={(e) => { e.preventDefault(); window.logout(); }} className="sidebar-link"><Icon d={ICONS.logout} />Sign Out</a>
        </div>
      </nav>
    </>
  );
}
