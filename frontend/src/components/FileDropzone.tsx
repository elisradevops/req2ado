import Box from '@mui/material/Box';
import Button from '@mui/material/Button';

export function FileDropzone({ onFileSelected }: { onFileSelected: (file: File) => void }): React.ReactElement {
  return (
    <Box border="2px dashed" borderColor="divider" borderRadius={2} p={4} textAlign="center">
      <Button component="label" variant="outlined">
        Upload File
        <input
          type="file"
          hidden
          aria-label="Upload requirements document"
          accept=".txt,.md,.docx,.pdf,.xlsx"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onFileSelected(file);
          }}
        />
      </Button>
    </Box>
  );
}
