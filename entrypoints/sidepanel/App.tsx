import { useState } from 'react';

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="max-w-5xl mx-auto p-8 text-center">
      <h1>Cebian Side Panel</h1>
      <div className="p-8 bg-amber-200">
        <button onClick={() => setCount((count) => count + 1)}>
          count is {count}
        </button>
      </div>
    </div>
  );
}

export default App;
