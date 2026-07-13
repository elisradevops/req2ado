import { useState, type ReactNode } from 'react';
import Box from '@mui/material/Box';
import Drawer from '@mui/material/Drawer';
import List from '@mui/material/List';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemIcon from '@mui/material/ListItemIcon';
import ListItemText from '@mui/material/ListItemText';
import IconButton from '@mui/material/IconButton';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Avatar from '@mui/material/Avatar';
import WorkIcon from '@mui/icons-material/Work';
import AddIcon from '@mui/icons-material/Add';
import HelpIcon from '@mui/icons-material/Help';
import StorageIcon from '@mui/icons-material/Storage';
import MenuIcon from '@mui/icons-material/Menu';
import { Link, useLocation } from 'react-router-dom';
import { themeTokens } from '../theme/tokens';
import { useDisplayName } from '../store/authStore';

const RAIL_EXPANDED_WIDTH = 220;
const RAIL_COLLAPSED_WIDTH = 64;

const NAV_ITEMS = [
  { to: '/jobs', label: 'Jobs', icon: <WorkIcon /> },
  { to: '/jobs/new', label: 'New Job', icon: <AddIcon /> },
  { to: '/knowledge-base', label: 'Knowledge Base', icon: <StorageIcon /> },
  { to: '/help', label: 'Help', icon: <HelpIcon /> },
];

export function AppShell({ children }: { children: ReactNode }): React.ReactElement {
  const [collapsed, setCollapsed] = useState(false);
  const location = useLocation();
  const displayName = useDisplayName();
  const width = collapsed ? RAIL_COLLAPSED_WIDTH : RAIL_EXPANDED_WIDTH;

  return (
    <Box display="flex">
      <Drawer
        variant="permanent"
        sx={{ width, '& .MuiDrawer-paper': { width, backgroundColor: themeTokens.color.railBackground, color: '#fff' } }}
      >
        <IconButton onClick={() => setCollapsed((prev) => !prev)} sx={{ color: '#fff', m: 1 }}>
          <MenuIcon />
        </IconButton>
        <List>
          {NAV_ITEMS.map((item) => (
            <ListItemButton key={item.to} component={Link} to={item.to} selected={location.pathname === item.to}>
              <ListItemIcon sx={{ color: '#fff' }}>{item.icon}</ListItemIcon>
              {!collapsed && <ListItemText primary={item.label} />}
            </ListItemButton>
          ))}
        </List>
      </Drawer>
      <Box flexGrow={1}>
        <AppBar position="static" color="default" elevation={0}>
          <Toolbar sx={{ justifyContent: 'space-between' }}>
            <Typography variant="body2" color="text.secondary">
              {location.pathname}
            </Typography>
            <Box display="flex" alignItems="center" gap={1}>
              <Typography variant="body2">{displayName ?? ''}</Typography>
              <Avatar sx={{ width: 32, height: 32 }}>{displayName?.[0] ?? '?'}</Avatar>
            </Box>
          </Toolbar>
        </AppBar>
        <Box p={2}>{children}</Box>
      </Box>
    </Box>
  );
}
