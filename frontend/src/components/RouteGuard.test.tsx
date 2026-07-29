import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { RouteGuard } from './RouteGuard';
import { useAuthStore } from '../store/authStore';

describe('RouteGuard', () => {
  beforeEach(() => {
    useAuthStore.getState().logout();
  });

  it('redirects to /login when unauthenticated', () => {
    render(
      <MemoryRouter initialEntries={['/jobs']}>
        <Routes>
          <Route path="/login" element={<div>Login Page</div>} />
          <Route path="/jobs" element={<RouteGuard><div>Jobs Page</div></RouteGuard>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Login Page')).toBeInTheDocument();
  });

  it('renders children when authenticated', () => {
    useAuthStore.getState().login('https://ado.example', 'Jane', 'user-descriptor-1');
    render(
      <MemoryRouter initialEntries={['/jobs']}>
        <Routes>
          <Route path="/login" element={<div>Login Page</div>} />
          <Route path="/jobs" element={<RouteGuard><div>Jobs Page</div></RouteGuard>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText('Jobs Page')).toBeInTheDocument();
  });
});
