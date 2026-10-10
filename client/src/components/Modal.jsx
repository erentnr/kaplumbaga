import { useState } from "react";

const Modal = (props) => {
  const [newUsername, setNewUsername] = useState('');

  const handleChange = (event) => {
    setNewUsername(event.target.value)
  }

  const handleClick = () => {
    props.onSave(newUsername.trim())
  }

  return (
    <div 
      className="modal-main"
      style={{display : props.showModal ? 'block' : 'none'}}
    >
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
          type="button"
          value="Save"
          onClick={handleClick}
          disabled={!newUsername.trim()}
        />
      </div>
    </div>
  )
};

export default Modal;
