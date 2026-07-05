import { useEffect, useState, type JSX } from 'react';
import { Box } from '@mui/material';
import ReactMarkdown from 'react-markdown';
import { httpClient } from '../api/httpClient.js';

export function Wiki(): JSX.Element {
  const [content, setContent] = useState('');

  useEffect(() => {
    void httpClient.get('/wiki', { responseType: 'text' }).then((response) => setContent(response.data));
  }, []);

  return (
    <Box sx={{ maxWidth: 720, mx: 'auto', mt: 8, p: 2 }}>
      <ReactMarkdown>{content}</ReactMarkdown>
    </Box>
  );
}
