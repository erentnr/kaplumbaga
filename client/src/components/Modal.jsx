import { useEffect, useRef, useState } from "react";

// Asks for a new username. Cancel, Escape or a click outside closes it.
const Modal = ({showModal, onSave, onClose}) => {
  const [newUsername, setNewUsername] = useState('');
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current
    if (showModal && !dialog.open) dialog.showModal()
    if (!showModal && dialog.open) dialog.close()
  }, [showModal]);

  const handleChange = (event) => {
    setNewUsername(event.target.value)
  }

  const handleSubmit = (event) => {
    event.preventDefault()
    if (newUsername.trim()) onSave(newUsername.trim())
  }

  // the content fills the dialog, so a click on the dialog itself is outside it
  const handleClick = (event) => {
    if (event.target === dialogRef.current) onClose()
  }

  return (
    <dialog
      ref={dialogRef}
      className="modal-main"
      onClose={onClose}
      onClick={handleClick}
    >
      <form className="modal-content" onSubmit={handleSubmit}>
        <div className="modal-header">
         <p>Type your new username</p>
        </div>

        <div className="username-wrapper">
          <input
            className="username-input"
            placeholder="Username..."
            value={newUsername}
            maxLength={24}
            onChange={handleChange}
          />
          <input
            className="username-save-button"
            type="submit"
            value="Save"
            disabled={!newUsername.trim()}
          />
          <input
            className="username-cancel-button"
            type="button"
            value="Cancel"
            onClick={onClose}
          />
        </div>
      </form>
    </dialog>
  )
};

export default Modal;
