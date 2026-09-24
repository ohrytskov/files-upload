const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pdfToPng, VerbosityLevel } = require('pdf-to-png-converter');
const { ensureDirectory, normalizeEntryName, pathIsWithin } = require('./local-filesystem');

const PDF_TO_PNG_DPI = 300;

class PdfConversionError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'PdfConversionError';
    this.code = code;
    Object.assign(this, details);
  }
}

function getPngPageName(pdfName, pageNumber) {
  const extension = path.extname(pdfName);
  const stem = path.basename(pdfName, extension) || 'document';
  return `${stem}_page_${String(pageNumber).padStart(3, '0')}.png`;
}

async function getRegularPdf(sourceDirectory, entryName) {
  const name = normalizeEntryName(entryName);
  if (!/\.pdf$/i.test(name)) {
    throw new PdfConversionError('Only PDF files can be copied as PNG.', 'INVALID_PDF');
  }

  const sourcePath = path.join(sourceDirectory, name);
  let stats;
  try {
    stats = await fs.promises.lstat(sourcePath);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw new PdfConversionError('A selected PDF could not be found.', 'NOT_FOUND');
    }
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw new PdfConversionError('Permission denied while reading a selected PDF.', 'PERMISSION_DENIED');
    }
    throw new PdfConversionError('Could not read a selected PDF.', 'SOURCE_READ_FAILED');
  }

  if (stats.isSymbolicLink()) {
    throw new PdfConversionError('Symbolic links cannot be converted.', 'SYMBOLIC_LINK');
  }
  if (!stats.isFile()) {
    throw new PdfConversionError('Only regular PDF files can be converted.', 'INVALID_PDF');
  }

  return { name, path: sourcePath };
}

async function inspectDestinationFile(destinationPath, name) {
  let stats;
  try {
    stats = await fs.promises.lstat(path.join(destinationPath, name));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error.code === 'EACCES' || error.code === 'EPERM') {
      throw new PdfConversionError('Permission denied while checking the destination.', 'PERMISSION_DENIED');
    }
    throw new PdfConversionError('Could not check the destination.', 'DESTINATION_ERROR');
  }

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new PdfConversionError(
      `The destination entry "${name}" is not a regular file.`,
      'INVALID_DESTINATION'
    );
  }
  return stats;
}

async function convertPdfsToPng({ sourcePath, destinationPath, entries, overwrite = false }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new PdfConversionError('Select at least one PDF file.', 'INVALID_ENTRY');
  }
  if (typeof overwrite !== 'boolean') {
    throw new PdfConversionError('overwrite must be a boolean.', 'INVALID_OPTION');
  }

  const sourceDirectory = await ensureDirectory(sourcePath, 'Source directory');
  const destinationDirectory = await ensureDirectory(destinationPath, 'Destination directory');
  const names = [...new Set(entries.map(normalizeEntryName))];
  const pdfs = [];
  for (const name of names) {
    pdfs.push(await getRegularPdf(sourceDirectory.resolved, name));
  }

  const stagingDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'cloudvault-pdf-to-png-'));
  const renderedPages = [];
  const errors = [];

  try {
    for (let index = 0; index < pdfs.length; index += 1) {
      const pdf = pdfs[index];
      const outputFolder = path.join(stagingDirectory, `pdf-${index}`);
      try {
        const pages = await pdfToPng(pdf.path, {
          outputFolder,
          outputFileMaskFunc: pageNumber => getPngPageName(pdf.name, pageNumber),
          viewportScale: PDF_TO_PNG_DPI / 72,
          verbosityLevel: VerbosityLevel.ERRORS,
          returnPageContent: false,
          renderInWorkerThreads: true,
          concurrencyLimit: 1
        });

        for (const page of pages) {
          if (page.kind !== 'file' || !page.path || !pathIsWithin(outputFolder, path.resolve(page.path))) {
            throw new PdfConversionError('The converter returned an invalid output path.', 'CONVERSION_FAILED');
          }
          renderedPages.push({
            sourceName: pdf.name,
            name: page.name,
            path: page.path,
            width: page.width,
            height: page.height
          });
        }
      } catch (error) {
        errors.push({
          entry: pdf.name,
          error: 'Could not convert this PDF at 300 DPI.'
        });
      }
    }

    if (renderedPages.length === 0) {
      return { files: [], errors, filesCopied: 0, bytesCopied: 0, dpi: PDF_TO_PNG_DPI };
    }

    const generatedNames = new Set();
    for (const page of renderedPages) {
      const portableName = page.name.toLocaleLowerCase('en-US');
      if (generatedNames.has(portableName)) {
        throw new PdfConversionError(
          'Selected PDFs would create duplicate PNG names. Select files with distinct names.',
          'OUTPUT_NAME_COLLISION'
        );
      }
      generatedNames.add(portableName);
    }

    const conflicts = [];
    for (const page of renderedPages) {
      const existing = await inspectDestinationFile(destinationDirectory.resolved, page.name);
      if (existing && !overwrite) conflicts.push(page.name);
    }
    if (conflicts.length > 0) {
      throw new PdfConversionError(
        'PNG files with these names already exist in the destination.',
        'DESTINATION_EXISTS',
        { conflicts }
      );
    }

    const files = [];
    let bytesCopied = 0;
    for (const page of renderedPages) {
      try {
        const targetPath = path.join(destinationDirectory.resolved, page.name);
        await fs.promises.copyFile(
          page.path,
          targetPath,
          overwrite ? 0 : fs.constants.COPYFILE_EXCL
        );
        const stats = await fs.promises.stat(targetPath);
        bytesCopied += stats.size;
        files.push({
          source: page.sourceName,
          name: page.name,
          width: page.width,
          height: page.height,
          size: stats.size
        });
      } catch (error) {
        errors.push({
          entry: page.sourceName,
          output: page.name,
          error: error.code === 'EEXIST'
            ? 'A PNG with this name already exists.'
            : 'Could not write this PNG to the destination.'
        });
      }
    }

    return {
      files,
      errors,
      filesCopied: files.length,
      bytesCopied,
      dpi: PDF_TO_PNG_DPI
    };
  } finally {
    try {
      await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
    } catch (error) {}
  }
}

module.exports = {
  PDF_TO_PNG_DPI,
  PdfConversionError,
  convertPdfsToPng
};
