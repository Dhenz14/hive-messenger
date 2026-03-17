import { useState } from 'react';
import { Download, Lock, AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { decryptImagePayload } from '@/lib/customJsonEncryption';
import { updateCustomJsonMessage, type CustomJsonMessage } from '@/lib/messageCache';

interface ImageMessageProps {
  message: CustomJsonMessage;
  currentUsername: string;
  className?: string;
}

export function ImageMessage({ message, currentUsername, className }: ImageMessageProps) {
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [decryptError, setDecryptError] = useState<string | null>(null);
  const [decryptedData, setDecryptedData] = useState<{
    imageData?: string;
    message?: string;
    filename?: string;
    contentType?: string;
  } | null>(message.isDecrypted ? message : null);
  const { toast } = useToast();

  const isSentByMe = message.from === currentUsername;
  const isDecrypted = message.isDecrypted || !!decryptedData;

  // Handle decryption on demand
  const handleDecrypt = async () => {
    if (isDecrypted) return; // Already decrypted

    setIsDecrypting(true);
    setDecryptError(null);

    try {
      console.log('[IMAGE] Decrypting message:', message.txId.substring(0, 20));

      const decrypted = await decryptImagePayload(
        message.encryptedPayload,
        currentUsername,
        message.hash
      );

      console.log('[IMAGE] Decryption successful');

      // Update IndexedDB with decrypted data
      await updateCustomJsonMessage(
        message.txId,
        {
          imageData: decrypted.imageData,
          message: decrypted.message,
          filename: decrypted.filename,
          contentType: decrypted.contentType,
          isDecrypted: true
        },
        currentUsername
      );

      // Update local state via React state (not prop mutation)
      setDecryptedData({
        imageData: decrypted.imageData,
        message: decrypted.message,
        filename: decrypted.filename,
        contentType: decrypted.contentType,
      });

      toast({
        title: 'Image Decrypted',
        description: 'Image decrypted successfully',
      });

    } catch (error: any) {
      console.error('[IMAGE] Decryption failed:', error);
      setDecryptError(error?.message || 'Decryption failed');
      
      toast({
        title: 'Decryption Failed',
        description: error?.message || 'Could not decrypt image',
        variant: 'destructive',
      });
    } finally {
      setIsDecrypting(false);
    }
  };

  // Resolved data: prefer local state, fall back to message props
  const imgData = decryptedData?.imageData || message.imageData;
  const imgCaption = decryptedData?.message || message.message;
  const imgFilename = decryptedData?.filename || message.filename;
  const imgContentType = decryptedData?.contentType || message.contentType;

  // Handle download
  const handleDownload = () => {
    if (!imgData || !isDecrypted) return;

    try {
      const link = document.createElement('a');
      link.href = `data:${imgContentType};base64,${imgData}`;
      link.download = imgFilename || 'image.webp';
      link.click();

      toast({
        title: 'Download Started',
        description: `Downloading ${imgFilename}`,
      });
    } catch (error) {
      toast({
        title: 'Download Failed',
        description: 'Could not download image',
        variant: 'destructive',
      });
    }
  };

  return (
    <div
      className={cn(
        'flex flex-col gap-2 max-w-sm',
        isSentByMe ? 'items-end' : 'items-start',
        className
      )}
      data-testid={`image-message-${message.txId}`}
    >
      {/* Image Container */}
      <div
        className={cn(
          'rounded-lg overflow-hidden border relative',
          isSentByMe ? 'bg-primary text-primary-foreground' : 'bg-muted'
        )}
      >
        {isDecrypted ? (
          // Decrypted: Show image
          <div className="relative group">
            <img
              src={`data:${imgContentType};base64,${imgData}`}
              alt={imgFilename || 'Image'}
              className="max-w-full h-auto max-h-96"
              data-testid="img-decrypted"
            />
            {/* Download button on hover */}
            <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <Button
                size="icon"
                variant="secondary"
                onClick={handleDownload}
                data-testid="button-download"
              >
                <Download className="w-4 h-4" />
              </Button>
            </div>
          </div>
        ) : (
          // Encrypted: Show placeholder with decrypt button
          <div className="w-64 h-40 flex flex-col items-center justify-center gap-3 p-6">
            {decryptError ? (
              <>
                <AlertCircle className="w-8 h-8 text-destructive" />
                <p className="text-sm text-center text-muted-foreground">
                  {decryptError}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleDecrypt}
                  disabled={isDecrypting}
                  data-testid="button-decrypt-retry"
                >
                  Retry
                </Button>
              </>
            ) : (
              <>
                <Lock className="w-8 h-8 text-muted-foreground" />
                <p className="text-sm text-center text-muted-foreground">
                  Encrypted Image
                  {message.chunks && message.chunks > 1 && (
                    <span className="block text-xs">({message.chunks} chunks)</span>
                  )}
                </p>
                <Button
                  size="sm"
                  variant={isSentByMe ? "secondary" : "default"}
                  onClick={handleDecrypt}
                  disabled={isDecrypting}
                  data-testid="button-decrypt"
                >
                  {isDecrypting ? 'Decrypting...' : 'Decrypt'}
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Optional text message */}
      {imgCaption && isDecrypted && (
        <div
          className={cn(
            'px-3 py-2 rounded-lg text-sm',
            isSentByMe ? 'bg-primary text-primary-foreground' : 'bg-muted'
          )}
          data-testid="text-image-caption"
        >
          {imgCaption}
        </div>
      )}

      {/* Metadata */}
      <div className="text-xs text-muted-foreground flex items-center gap-2">
        {isDecrypted && imgFilename && (
          <span data-testid="text-filename">{imgFilename}</span>
        )}
        {message.hash && (
          <span className="opacity-70" data-testid="text-hash">
            #{message.hash.substring(0, 6)}
          </span>
        )}
      </div>
    </div>
  );
}
