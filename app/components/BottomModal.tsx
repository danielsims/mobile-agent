import { Modal } from 'react-native';
import { Drawer } from './Drawer';

interface BottomModalProps {
  isVisible: boolean;
  onClose: () => void;
  children: React.ReactNode;
  title?: string;
  showCloseButton?: boolean;
}

export function BottomModal({
  isVisible,
  onClose,
  children,
  title,
  showCloseButton = true,
}: BottomModalProps) {
  return (
    <Modal
      visible={isVisible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <Drawer
        isOpen={isVisible}
        onClose={onClose}
        title={title}
        showCloseButton={showCloseButton}
      >
        {children}
      </Drawer>
    </Modal>
  );
}
