import { Button } from '@/components/ui/button';
import { useState } from 'react';

function App() {
  const [count, setCount] = useState(0);

  return (
    <div className="max-w-5xl mx-auto p-8 text-center">
      <h1>Cebian Side Panel</h1>
      <div className="p-8 bg-amber-200">
        <Button onClick={() => setCount((count) => count + 1)}>
          count is {count}
        </Button>
      </div>
        <Button>haha</Button>

    </div>
  );
}

export default App;
