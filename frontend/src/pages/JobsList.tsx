import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Button from '@mui/material/Button';
import Box from '@mui/material/Box';
import { listJobs } from '../api/jobs';
import { useJobsStore, useJobs } from '../store/jobsStore';
import { StatusChip } from '../components/StatusChip';
import { ModeBadge } from '../components/ModeBadge';

export function JobsList(): React.ReactElement {
  const jobs = useJobs();
  const setJobs = useJobsStore((state) => state.setJobs);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    listJobs().then((result) => {
      if (!cancelled) {
        setJobs(result);
        setLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [setJobs]);

  if (loaded && jobs.length === 0) {
    return (
      <Box textAlign="center" py={8}>
        <p>No jobs yet.</p>
        <Button component={Link} to="/jobs/new" variant="contained">Create your first job</Button>
      </Box>
    );
  }

  return (
    <Table>
      <TableHead>
        <TableRow>
          <TableCell>Mode</TableCell>
          <TableCell>Status</TableCell>
          <TableCell>Items</TableCell>
          <TableCell>Area Path</TableCell>
          <TableCell>Created</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id} component={Link} to={`/jobs/${job.id}`} sx={{ cursor: 'pointer' }}>
            <TableCell><ModeBadge mode={job.mode as 'baseline' | 'survey'} /></TableCell>
            <TableCell><StatusChip status={job.status} /></TableCell>
            <TableCell>{job.itemCount}</TableCell>
            <TableCell>{job.areaPath}</TableCell>
            <TableCell>{new Date(job.createdAt).toLocaleString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
