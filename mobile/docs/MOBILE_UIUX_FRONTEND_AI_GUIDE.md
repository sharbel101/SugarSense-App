# Mobile UI/UX Development Standards Guide for Frontend AI
## Deep Research-Based Instructions (2025-2026)

**Version:** 1.0  
**Last Updated:** September 2026  
**Target:** React/React Native Mobile Applications  
**Audience:** Frontend AI Assistant Building Mobile Apps

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Core Design Philosophy](#core-design-philosophy)
3. [Platform-Specific Guidelines](#platform-specific-guidelines)
4. [Design Principles & Best Practices](#design-principles--best-practices)
5. [React Architecture & Components](#react-architecture--components)
6. [UI/UX Implementation Standards](#uiux-implementation-standards)
7. [Performance Optimization](#performance-optimization)
8. [Accessibility & WCAG Compliance](#accessibility--wcag-compliance)
9. [Mobile-First Responsive Design](#mobile-first-responsive-design)
10. [Developer Workflow & Tooling](#developer-workflow--tooling)

---

## Executive Summary

This guide establishes comprehensive standards for building best-in-class mobile applications. It combines industry-leading design frameworks (Apple HIG, Google Material Design 3), modern React development practices, and research-backed UX principles from 2025-2026 analysis.

**Key Takeaways:**
- Prioritize **content-first design** with minimal cognitive load
- Follow **platform-native guidelines** (iOS HIG or Material Design 3)
- Implement **one-hand-centered design** for mobile devices
- Use **React best practices** with component-based architecture
- Optimize **performance** from initial build (lazy loading, image optimization, code splitting)
- Ensure **accessibility** (WCAG 2.1 AA) from day one

---

## Core Design Philosophy

### 1. User-Centric Hierarchy

**Principle:** Users should understand the app's purpose and navigate core functions within 3 seconds.

**Implementation:**
- Define 3-5 core user tasks at app conception
- Use visual hierarchy to guide attention to primary actions
- Minimize cognitive load by reducing visible options
- Prioritize content discovery over feature sprawl

### 2. Platform Authenticity

**Principle:** Respect platform conventions—don't fight native patterns.

**Implementation:**
- **iOS apps:** Use Apple's Human Interface Guidelines (HIG)
  - Bottom navigation (tab bar)
  - Native back button behavior
  - Gesture-driven interactions (swipe, long-press)
  - iOS-native design components
- **Android apps:** Use Google's Material Design 3
  - Top app bar with navigation drawer
  - Floating action buttons (FAB)
  - Material motion and elevation
  - Material 3 components library

### 3. Gesture-First Interaction

**Principle:** Mobile users expect gesture-driven interfaces.

**Implementation:**
- **Swipe:** Page navigation, item dismissal
- **Long-press:** Context menus, favorites
- **Pinch:** Zoom on images/maps
- **Tap + Hold:** Drag and drop
- **Double-tap:** Zoom, likes/favorites
- **Avoid:** Overloading with ambiguous gestures; test with target users

---

## Platform-Specific Guidelines

### iOS (Apple Human Interface Guidelines - 2025)

#### Visual Design
- **Safe Area:** Always respect notch and dynamic island
- **Color:** Use system colors for automatic dark mode support
- **Typography:**
  - SF Pro Display (headlines)
  - SF Pro Text (body copy)
  - Min 14pt for body text; min 17pt minimum for readability
- **Spacing:** Use 8pt base unit grid
  - Margins: 16pt
  - Spacing between elements: 8pt, 12pt, 16pt, 20pt

#### Navigation
- **Tab Bar:** 4-5 tabs maximum, bottom placement
- **Navigation Stack:** iOS standard back button (chevron)
- **Modal:** Use for focused tasks; include dismiss affordance
- **Gesture:** Swipe back is expected default behavior

#### Key Components
- Navigation Tab Bar (UITabBar)
- Navigation Controller stack
- Table Views / Collection Views (scrollable lists)
- Action Sheets for non-modal choices
- Pull-to-Refresh for updates

#### Haptic Feedback
- Light impact: tap feedback
- Medium impact: selection change
- Heavy impact: alerts
- Notification haptic: warning/success patterns

### Android (Material Design 3 - 2025)

#### Visual Design
- **Elevation & Shadows:** Material 3 reduced shadow depth
- **Color:** Use Material 3 color system (tone-based)
  - Primary, Secondary, Tertiary, Neutral colors
  - Dynamic color support (Material You)
- **Typography:**
  - Roboto for default (or system font)
  - Display (36pt), Headline (28-32pt), Title (16-20pt), Body (14-16pt), Label (12-14pt)
- **Spacing:** 4pt grid for precise alignment
  - Margins: 16dp standard
  - Gutters: 16-24dp

#### Navigation
- **Top App Bar:** Material 3 single-line variant
- **Bottom Navigation:** 3-5 destinations
- **Navigation Drawer:** Side navigation for secondary options
- **Gesture:** Swipe back from edge (system gesture)

#### Key Components
- Material 3 Button (elevated, filled, tonal, outlined, text)
- Material 3 Card (elevated, filled, outlined)
- Material 3 Lists (single-line, two-line, three-line)
- Bottom Sheets for expanded options
- Snackbars for confirmation/alerts

#### Motion & Haptics
- 300-400ms animation duration standard
- Material easing curves (standard, emphasized)
- Haptic feedback for selections and confirmations

---

## Design Principles & Best Practices

### 1. Simplicity & Content-First Design

**Standard:** Every UI element must serve a purpose.

**Checklist for Frontend AI:**
- [ ] Remove elements that don't directly support primary user task
- [ ] Prioritize content over chrome/decoration
- [ ] Group related functionality together
- [ ] Use whitespace (negative space) to create visual breathing room
- [ ] Maintain signal-to-noise ratio: min 60% content, max 40% UI chrome

**Example:**
```
❌ BAD: 10 buttons on home screen, complex menu hierarchies
✅ GOOD: 3 primary actions, clear visual hierarchy, secondary actions in menu
```

### 2. One-Hand-Centered Design (Critical for Mobile)

**Standard:** 60%+ of interactive elements must be reachable by thumb.

**Implementation:**
- **Thumb Zone Map (5.5" device):**
  - Easy Zone (center-to-lower): 50-80% of interactions
  - Moderate Zone (upper area): navigation, less frequent actions
  - Hard Zone (top): back buttons only if absolutely necessary

**Frontend AI Actions:**
- Position primary CTAs in thumb zone (center-lower 60%)
- Place back buttons or navigation in top area
- Avoid buttons smaller than 44x44pt (iOS) or 48x48dp (Android)
- Test with one-handed usage scenarios

### 3. Gesture UI Without Overload

**Standard:** Use gestures to enhance, not replace tap.

**Recommended Gestures (by priority):**

| Gesture | Use Case | Priority |
|---------|----------|----------|
| Tap | Select, open, confirm | Essential |
| Swipe Horizontal | Page/tab navigation | Essential |
| Swipe Up | Dismiss modal, scroll | Essential |
| Long-press | Context menu, selection | Important |
| Pinch | Zoom on images/maps | Important |
| Double-tap | Like, favorite, zoom | Optional |
| Swipe Down | Pull-to-refresh | Platform-dependent |

**Constraint:** Max 3-4 gesture types per screen.

### 4. Design Consistency Across Platforms

**Standard:** Unified brand identity with platform-native patterns.

**Frontend AI Approach:**
- Define design system with shared components
- Create platform-specific overrides
- Use adaptive components (render iOS or Android variant)
- Maintain color palette, typography, and spacing uniformly
- Document exceptions

**Design System Elements to Define:**
- Color palette (dark mode + light mode)
- Typography scale (6-8 styles)
- Spacing scale (8pt base unit: 8, 16, 24, 32, 48, 64px)
- Button states (normal, pressed, disabled, loading)
- Input field states (normal, focused, error, success)
- Loading indicators, progress bars, skeletons
- Shadow/elevation system

### 5. Notification Strategy

**Standard:** Notifications are "non-interfering" and contextual.

**Frontend AI Guidelines:**
- **Toast/Snackbar:** Transient notifications (actions confirmations, quick messages)
  - Duration: 3-4 seconds
  - Position: Bottom (iOS), Bottom (Android material standard)
  - No blocking or interruption

- **In-App Alerts:** Important, actionable information
  - Use only for warnings, errors, critical confirmations
  - Max 2 buttons (primary + secondary)
  - Clear, concise messaging (max 2 lines)

- **Push Notifications:** Strategic only
  - Require explicit user opt-in
  - Personalized and timely
  - Avoid duplicate/spam notifications

### 6. Onboarding & User Retention

**Standard:** Compact, engaging onboarding requesting only essential info upfront.

**Best Practice:**
- **First Launch:** 1-3 screens maximum
  - Screen 1: App value proposition
  - Screen 2: Core feature overview (optional)
  - Screen 3: Permissions request
  - No email/signup on first visit if not absolutely required

- **Empty States:** Elegant, guidance-driven
  - Illustration + headline
  - Clear call-to-action
  - Explain what this screen does when populated

- **Tutorials:** Contextual, in-app
  - Show tooltips for complex features (not all features)
  - Highlight key UI elements on first use
  - Option to skip tutorials

---

## React Architecture & Components

### Component Structure for Mobile Apps

**Principle:** Component-based architecture with clear separation of concerns.

#### Recommended Folder Structure

```
src/
├── components/
│   ├── common/           # Reusable UI components
│   │   ├── Button.jsx
│   │   ├── Card.jsx
│   │   ├── Input.jsx
│   │   ├── Modal.jsx
│   │   └── Loader.jsx
│   ├── layout/          # Layout wrapper components
│   │   ├── Header.jsx
│   │   ├── Footer.jsx
│   │   ├── Sidebar.jsx
│   │   └── SafeAreaView.jsx
│   └── screens/         # Full-screen feature components
│       ├── HomeScreen.jsx
│       ├── ProfileScreen.jsx
│       └── SettingsScreen.jsx
├── hooks/               # Custom React hooks
│   ├── useFetch.js
│   ├── useLocalStorage.js
│   └── useResponsive.js
├── utils/               # Utility functions
│   ├── formatting.js
│   ├── validation.js
│   └── constants.js
├── styles/              # Global styles, theme
│   ├── theme.js
│   ├── colors.js
│   └── spacing.js
├── services/            # API, authentication, business logic
│   ├── api.js
│   ├── auth.js
│   └── storage.js
└── App.jsx
```

### Component Development Standards

#### 1. Functional Components (Default)

**Standard:** Use functional components with hooks exclusively (no class components).

```jsx
// ✅ GOOD
const Button = ({ label, onPress, loading = false, variant = 'primary' }) => {
  return (
    <button
      onClick={onPress}
      disabled={loading}
      className={`btn btn-${variant}`}
      aria-label={label}
    >
      {loading ? <Spinner size="sm" /> : label}
    </button>
  );
};

// ❌ AVOID
class Button extends React.Component { ... }
```

#### 2. Props & TypeScript

**Standard:** Use TypeScript for all new components (or PropTypes as fallback).

```jsx
interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const Button: React.FC<ButtonProps> = ({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  size = 'md',
}) => {
  // Component implementation
};
```

#### 3. State Management

**Recommended Approach by Complexity:**

| Complexity | Solution | Use Case |
|-----------|----------|----------|
| Local component state | `useState` | Form inputs, toggle states |
| Sibling/parent sharing | `useContext` + `useReducer` | App-level auth, theme |
| Global app state | Redux Toolkit or Zustand | Complex multi-screen data |
| API/Server state | React Query or SWR | Fetching, caching, sync |

**Frontend AI Standard:** Use hooks for state, avoid prop-drilling.

```jsx
// ✅ GOOD: Context API for simple global state
const ThemeContext = createContext();

export const ThemeProvider = ({ children }) => {
  const [theme, setTheme] = useState('light');
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

// ✅ GOOD: React Query for server state
const { data: user, isLoading, error } = useQuery(
  ['user', userId],
  () => fetchUser(userId),
  { staleTime: 1000 * 60 * 5 } // 5 min cache
);
```

#### 4. Custom Hooks for Mobile

**Essential Hooks to Create:**

```jsx
// hooks/useResponsive.js
const useResponsive = () => {
  const [screenSize, setScreenSize] = useState({
    width: window.innerWidth,
    height: window.innerHeight,
  });

  useEffect(() => {
    const handleResize = () => {
      setScreenSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return {
    isMobile: screenSize.width < 768,
    isTablet: screenSize.width >= 768 && screenSize.width < 1024,
    isDesktop: screenSize.width >= 1024,
    width: screenSize.width,
    height: screenSize.height,
  };
};

// hooks/useLocalStorage.js
const useLocalStorage = (key, initialValue) => {
  const [storedValue, setStoredValue] = useState(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch {
      return initialValue;
    }
  });

  const setValue = (value) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (e) {
      console.error('localStorage error:', e);
    }
  };

  return [storedValue, setValue];
};

// hooks/useFetch.js (Alternative to React Query)
const useFetch = (url, options = {}) => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch(url, options);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = await response.json();
        setData(json);
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [url]);

  return { data, loading, error };
};
```

---

## UI/UX Implementation Standards

### 1. Color System & Theming

**Standard:** Implement light mode + dark mode from day one.

#### Color Palette Structure

```jsx
// styles/colors.js
const colors = {
  // Brand colors
  primary: '#007AFF', // iOS Blue
  secondary: '#5AC8FA', // Light Blue
  tertiary: '#34C759', // Green

  // Neutrals
  background: '#FFFFFF',
  surface: '#F2F2F7',
  text: {
    primary: '#000000',
    secondary: '#666666',
    tertiary: '#999999',
  },

  // Status
  success: '#34C759',
  warning: '#FF9500',
  error: '#FF3B30',
  info: '#00C7BE',

  // Semantic
  border: '#EBEBF0',
  overlay: 'rgba(0, 0, 0, 0.5)',
};

// Dark mode override
const darkColors = {
  background: '#000000',
  surface: '#1C1C1E',
  text: {
    primary: '#FFFFFF',
    secondary: '#CCCCCC',
    tertiary: '#666666',
  },
  // ... other overrides
};
```

#### Theme Provider Implementation

```jsx
// context/ThemeContext.jsx
const ThemeContext = createContext();

export const ThemeProvider = ({ children }) => {
  const [isDark, setIsDark] = useState(() => {
    // Check system preference
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  const colors = isDark ? darkColors : lightColors;

  useEffect(() => {
    document.documentElement.setAttribute(
      'data-theme',
      isDark ? 'dark' : 'light'
    );
  }, [isDark]);

  return (
    <ThemeContext.Provider value={{ isDark, setIsDark, colors }}>
      {children}
    </ThemeContext.Provider>
  );
};
```

### 2. Typography System

**Standard:** Limited, predictable type scale.

```jsx
// styles/typography.js
export const typography = {
  // Display (Large headlines)
  display: {
    fontSize: '36px',
    fontWeight: 700,
    lineHeight: 1.2,
    letterSpacing: -0.5,
  },

  // Headline (Section titles)
  headline: {
    fontSize: '28px',
    fontWeight: 700,
    lineHeight: 1.3,
  },

  // Title (Screen titles)
  title: {
    fontSize: '20px',
    fontWeight: 600,
    lineHeight: 1.4,
  },

  // Body (Primary text)
  body: {
    fontSize: '16px',
    fontWeight: 400,
    lineHeight: 1.5,
  },

  // Subtitle (Secondary info)
  subtitle: {
    fontSize: '14px',
    fontWeight: 500,
    lineHeight: 1.4,
  },

  // Label (Buttons, small text)
  label: {
    fontSize: '12px',
    fontWeight: 600,
    lineHeight: 1.3,
    letterSpacing: 0.2,
  },

  // Caption (Smallest text)
  caption: {
    fontSize: '11px',
    fontWeight: 400,
    lineHeight: 1.2,
  },
};

// Usage in component
const Text = ({ variant = 'body', children, ...props }) => (
  <span style={typography[variant]} {...props}>
    {children}
  </span>
);
```

### 3. Spacing System

**Standard:** 8pt base unit (or 4pt for precise alignment).

```jsx
// styles/spacing.js
export const spacing = {
  xs: '4px',   // Extra small
  sm: '8px',   // Small
  md: '16px',  // Medium (default margin)
  lg: '24px',  // Large
  xl: '32px',  // Extra large
  xxl: '48px', // 2x Large
  xxxl: '64px', // 3x Large
};

// Margin shortcuts
export const margins = {
  container: '16px', // Left-right margin on main content
  section: '24px',   // Between major sections
  component: '8px',  // Between components
};

// Usage
const Card = ({ children }) => (
  <div style={{ padding: spacing.md, margin: margins.component }}>
    {children}
  </div>
);
```

### 4. Button System

**Standard:** 4-5 button variants, consistent across platform.

```jsx
// components/common/Button.jsx
interface ButtonProps {
  variant?: 'primary' | 'secondary' | 'tertiary' | 'danger' | 'text';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  children: React.ReactNode;
  onPress: () => void;
  fullWidth?: boolean;
}

const Button: React.FC<ButtonProps> = ({
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  icon,
  children,
  onPress,
  fullWidth = false,
}) => {
  const sizeClasses = {
    sm: 'px-3 py-2 text-sm',
    md: 'px-6 py-3 text-base',
    lg: 'px-8 py-4 text-lg',
  };

  const variantClasses = {
    primary: 'bg-blue-500 text-white hover:bg-blue-600 active:bg-blue-700',
    secondary: 'bg-gray-200 text-gray-900 hover:bg-gray-300',
    tertiary: 'bg-transparent text-blue-500 hover:bg-blue-50',
    danger: 'bg-red-500 text-white hover:bg-red-600',
    text: 'bg-transparent text-gray-700 hover:underline',
  };

  return (
    <button
      onClick={onPress}
      disabled={disabled || loading}
      className={`
        inline-flex items-center justify-center gap-2 rounded-lg font-medium
        transition-colors duration-200 min-h-[44px] min-w-[44px]
        disabled:opacity-50 disabled:cursor-not-allowed
        ${sizeClasses[size]}
        ${variantClasses[variant]}
        ${fullWidth ? 'w-full' : ''}
      `}
    >
      {loading ? <Spinner size="sm" /> : icon}
      {children}
    </button>
  );
};

export default Button;
```

### 5. Input Fields

**Standard:** Consistent input styling with clear states.

```jsx
// components/common/Input.jsx
interface InputProps {
  type?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  label?: string;
  icon?: React.ReactNode;
}

const Input: React.FC<InputProps> = ({
  type = 'text',
  placeholder,
  value,
  onChange,
  error,
  disabled = false,
  required = false,
  label,
  icon,
}) => {
  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-gray-900 mb-2">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      <div className="relative">
        {icon && <span className="absolute left-3 top-3">{icon}</span>}
        <input
          type={type}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          className={`
            w-full px-4 py-3 rounded-lg border-2 transition-colors
            ${icon ? 'pl-10' : ''}
            ${
              error
                ? 'border-red-500 focus:border-red-600'
                : 'border-gray-300 focus:border-blue-500'
            }
            ${disabled ? 'bg-gray-100 cursor-not-allowed' : 'bg-white'}
            focus:outline-none
          `}
        />
      </div>
      {error && <p className="text-red-500 text-sm mt-1">{error}</p>}
    </div>
  );
};

export default Input;
```

---

## Performance Optimization

### 1. Image Optimization

**Standard:** No unoptimized images shipped to production.

#### Implementation Checklist:

- [ ] **Image Formats:** Use WebP with fallback to JPEG/PNG
  ```jsx
  <picture>
    <source srcSet="image.webp" type="image/webp" />
    <source srcSet="image.jpg" type="image/jpeg" />
    <img src="image.jpg" alt="description" />
  </picture>
  ```

- [ ] **Responsive Images:** Multiple sizes for different devices
  ```jsx
  <img
    srcSet="image-320w.jpg 320w, image-640w.jpg 640w, image-1280w.jpg 1280w"
    sizes="(max-width: 600px) 320px, (max-width: 1200px) 640px, 1280px"
    src="image-640w.jpg"
    alt="description"
  />
  ```

- [ ] **Lazy Loading:** Images below fold load only when needed
  ```jsx
  <img src="image.jpg" alt="description" loading="lazy" />
  ```

- [ ] **Next.js Image Component** (if using Next.js)
  ```jsx
  import Image from 'next/image';

  <Image
    src="/image.jpg"
    alt="description"
    width={640}
    height={480}
    priority={false} // Lazy load by default
  />
  ```

- [ ] **Image Compression:** All images compressed before upload
  - JPEGs: 80-85% quality
  - PNGs: Optimized with pngquant
  - Use tools: TinyPNG, ImageOptim, Cloudinary

### 2. Code Splitting & Lazy Loading

**Standard:** Load code only when needed.

```jsx
// ✅ GOOD: Route-based code splitting
import { lazy, Suspense } from 'react';

const HomeScreen = lazy(() => import('./screens/HomeScreen'));
const ProfileScreen = lazy(() => import('./screens/ProfileScreen'));

const Router = () => (
  <Suspense fallback={<LoadingSpinner />}>
    <Routes>
      <Route path="/" element={<HomeScreen />} />
      <Route path="/profile" element={<ProfileScreen />} />
    </Routes>
  </Suspense>
);

// ✅ GOOD: Component-level splitting
const Modal = lazy(() => import('./components/Modal'));

function App() {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <button onClick={() => setShowModal(true)}>Open</button>
      {showModal && (
        <Suspense fallback={null}>
          <Modal onClose={() => setShowModal(false)} />
        </Suspense>
      )}
    </>
  );
}
```

### 3. Bundle Size Optimization

**Standard:** Keep main bundle under 100KB (gzipped).

#### Optimization Strategies:

```jsx
// ❌ Don't import entire libraries
import _ from 'lodash';

// ✅ Import only what you need
import debounce from 'lodash/debounce';

// ✅ Or use native alternatives
const debounce = (fn, delay) => {
  let timeoutId;
  return (...args) => {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => fn(...args), delay);
  };
};
```

**Frontend AI Checklist:**
- [ ] Analyze bundle with `webpack-bundle-analyzer`
- [ ] Remove unused dependencies
- [ ] Use tree-shaking friendly packages (ES modules)
- [ ] Minify & compress all assets
- [ ] Use dynamic imports for heavy libraries

### 4. Runtime Performance

**Standard:** Target 60 FPS, <3s Time to Interactive.

#### Optimization Techniques:

```jsx
// ✅ GOOD: Memoization for expensive renders
const ListItem = React.memo(({ item, onSelect }) => (
  <div onClick={() => onSelect(item.id)}>
    {item.name}
  </div>
));

// ✅ GOOD: useCallback for stable function refs
const MyComponent = () => {
  const [items, setItems] = useState([]);

  const handleSelect = useCallback((id) => {
    console.log('Selected:', id);
  }, []);

  return <ListItem onSelect={handleSelect} />;
};

// ✅ GOOD: useMemo for expensive computations
const ExpensiveList = ({ items, filterText }) => {
  const filteredItems = useMemo(() => {
    return items.filter(item =>
      item.name.toLowerCase().includes(filterText.toLowerCase())
    );
  }, [items, filterText]);

  return <div>{filteredItems.map(item => <div>{item.name}</div>)}</div>;
};

// ✅ GOOD: Virtual scrolling for long lists
import { FixedSizeList as List } from 'react-window';

const Row = ({ index, style }) => (
  <div style={style}>Item {index}</div>
);

const LongList = ({ items }) => (
  <List height={600} itemCount={items.length} itemSize={35} width="100%">
    {Row}
  </List>
);
```

### 5. Network Optimization

**Standard:** Minimize network requests, intelligent caching.

```jsx
// ✅ GOOD: Request batching & debouncing
const useSearch = (query) => {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!query) {
      setResults([]);
      return;
    }

    const timeoutId = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        setResults(await res.json());
      } finally {
        setLoading(false);
      }
    }, 300); // Debounce 300ms

    return () => clearTimeout(timeoutId);
  }, [query]);

  return { results, loading };
};

// ✅ GOOD: HTTP caching headers
// Server should set:
// Cache-Control: max-age=3600 (1 hour)
// ETag: "12345" (for cache validation)

// ✅ GOOD: React Query with smart caching
const { data: user } = useQuery(
  ['user', userId],
  () => fetchUser(userId),
  {
    staleTime: 1000 * 60 * 5, // 5 min stale time
    cacheTime: 1000 * 60 * 10, // 10 min cache
    refetchOnWindowFocus: false, // Avoid unnecessary refetch
  }
);
```

---

## Accessibility & WCAG Compliance

### Standards: WCAG 2.1 Level AA (Minimum)

### 1. Keyboard Navigation

**Standard:** All interactive elements accessible via keyboard.

```jsx
// ✅ GOOD: Semantic HTML + ARIA attributes
<nav role="navigation" aria-label="Main navigation">
  <button
    onClick={handleMenu}
    aria-expanded={isOpen}
    aria-controls="menu-list"
  >
    Menu
  </button>
  <ul id="menu-list" role="menu">
    <li><a href="/about">About</a></li>
  </ul>
</nav>

// ✅ GOOD: Focus management
const Modal = ({ isOpen, onClose }) => {
  const modalRef = useRef(null);

  useEffect(() => {
    if (isOpen) {
      modalRef.current?.focus();
    }
  }, [isOpen]);

  return (
    <div ref={modalRef} role="dialog" tabIndex={-1}>
      <button onClick={onClose}>Close</button>
    </div>
  );
};
```

### 2. Color Contrast

**Standard:** WCAG AA minimum 4.5:1 (normal text), 3:1 (large text).

```jsx
// ✅ Check contrast ratios
// Use: https://www.webaim.org/resources/contrastchecker/

// Good contrast examples:
// - Black (#000) on White (#FFF): 21:1 ✓
// - Dark Blue (#003da5) on White (#FFF): 8.59:1 ✓
// - Gray (#767676) on White (#FFF): 4.54:1 ✓
// - Light Gray (#999) on White (#FFF): 3.15:1 ✗ (Too low for normal text)
```

### 3. Screen Reader Support

**Standard:** Meaningful alt text, ARIA labels where needed.

```jsx
// ✅ GOOD: Descriptive alt text
<img src="chart.png" alt="Sales increased 25% in Q3" />

// ✅ GOOD: ARIA labels for icons
<button aria-label="Close menu">
  <IconClose />
</button>

// ✅ GOOD: Form labels
<label htmlFor="email">Email Address</label>
<input id="email" type="email" />

// ✅ GOOD: Live regions for dynamic content
<div aria-live="polite" aria-atomic="true">
  {successMessage}
</div>
```

### 4. Motion & Animation

**Standard:** Respect `prefers-reduced-motion`.

```jsx
const useReducedMotion = () => {
  const [prefersReduced, setPrefersReduced] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReduced(mediaQuery.matches);

    const handleChange = (e) => setPrefersReduced(e.matches);
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return prefersReduced;
};

// Usage
const Card = () => {
  const prefersReduced = useReducedMotion();

  return (
    <div
      style={{
        animation: prefersReduced
          ? 'none'
          : 'fadeIn 0.3s ease-in',
      }}
    >
      Content
    </div>
  );
};
```

---

## Mobile-First Responsive Design

### Breakpoints Standard

```jsx
// styles/breakpoints.js
export const breakpoints = {
  mobile: 0,      // 320px - 639px (phones)
  tablet: 640,    // 640px - 1023px (tablets)
  desktop: 1024,  // 1024px+ (desktops)
};

export const mediaQueries = {
  mobile: '@media (max-width: 639px)',
  tablet: '@media (min-width: 640px) and (max-width: 1023px)',
  desktop: '@media (min-width: 1024px)',
};
```

### Tailwind CSS Mobile-First Approach

```jsx
// ✅ GOOD: Mobile-first (default), then tablet, then desktop
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
  {items.map(item => <Card key={item.id} {...item} />)}
</div>

// ✅ GOOD: Responsive font sizes
<h1 className="text-2xl md:text-3xl lg:text-4xl">
  Responsive Heading
</h1>

// ✅ GOOD: Responsive spacing
<div className="p-4 md:p-6 lg:p-8">
  Content with responsive padding
</div>
```

### Safe Area & Notch Awareness

```jsx
// ✅ GOOD: Safe area insets (React Native Web)
<div
  style={{
    paddingTop: 'max(env(safe-area-inset-top), 16px)',
    paddingLeft: 'max(env(safe-area-inset-left), 16px)',
    paddingRight: 'max(env(safe-area-inset-right), 16px)',
    paddingBottom: 'max(env(safe-area-inset-bottom), 16px)',
  }}
>
  Safe content area
</div>

// ✅ GOOD: Fixed headers respecting notch
<header
  style={{
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    paddingTop: 'env(safe-area-inset-top)',
    zIndex: 1000,
  }}
>
  Navigation
</header>
```

### Touch Target Sizing

**Standard:** Min 44x44pt (iOS) / 48x48dp (Android).

```jsx
// ✅ GOOD: Proper touch target
<button
  style={{
    minHeight: '44px',
    minWidth: '44px',
    padding: '12px 16px',
  }}
>
  Action
</button>

// ✅ GOOD: Spacious list items
<li style={{ minHeight: '56px', padding: '12px 16px' }}>
  List item with good spacing
</li>
```

---

## Developer Workflow & Tooling

### Essential Tools & Libraries

#### Recommended Stack for React Mobile Apps:

| Category | Recommendation | Alternative |
|----------|-----------------|-------------|
| **Framework** | React 18+ | - |
| **Styling** | Tailwind CSS + CSS Modules | Styled Components |
| **UI Components** | shadcn/ui + Radix UI | Material UI, Chakra UI |
| **State Mgmt** | Zustand / Context + useReducer | Redux Toolkit, Jotai |
| **Server State** | React Query (TanStack Query) | SWR, Apollo |
| **Routing** | React Router v6+ / Next.js | TanStack Router |
| **Forms** | React Hook Form + Zod | Formik, Yup |
| **Testing** | Vitest + React Testing Library | Jest, Testing Library |
| **Build Tool** | Vite | Next.js, webpack |
| **Type Safety** | TypeScript | PropTypes |
| **Linting** | ESLint + Prettier | - |
| **Mobile (Native)** | React Native + Expo | NativeScript |

### Project Setup Checklist

```bash
# ✅ DO THIS for every new mobile app project

# 1. Initialize project
npm create vite@latest my-app -- --template react
cd my-app

# 2. Install core dependencies
npm install react-router-dom zustand react-query
npm install -D tailwindcss postcss autoprefixer
npm install -D typescript @types/react @types/node

# 3. Set up linting
npm install -D eslint eslint-plugin-react prettier

# 4. Configure TypeScript
npx tsc --init

# 5. Set up Tailwind
npx tailwindcss init -p

# 6. Add testing
npm install -D vitest @testing-library/react @testing-library/jest-dom

# 7. .gitignore
echo "node_modules\n.env.local\ndist\n.DS_Store" > .gitignore

# 8. Environment variables
echo "VITE_API_URL=http://localhost:3000" > .env.local
```

### Code Quality Standards

#### ESLint Configuration

```json
{
  "extends": [
    "eslint:recommended",
    "plugin:react/recommended",
    "plugin:react-hooks/recommended",
    "plugin:@typescript-eslint/recommended"
  ],
  "rules": {
    "react/react-in-jsx-scope": "off",
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn",
    "@typescript-eslint/no-explicit-any": "warn",
    "no-console": ["warn", { "allow": ["warn", "error"] }]
  }
}
```

#### Prettier Configuration

```json
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "es5",
  "printWidth": 80,
  "tabWidth": 2,
  "useTabs": false,
  "arrowParens": "always"
}
```

### Performance Monitoring

**Standard:** Measure real-world performance metrics.

```jsx
// Measure Web Vitals
import { getCLS, getFID, getFCP, getLCP, getTTFB } from 'web-vitals';

getCLS(console.log); // Cumulative Layout Shift
getFID(console.log); // First Input Delay
getFCP(console.log); // First Contentful Paint
getLCP(console.log); // Largest Contentful Paint
getTTFB(console.log); // Time to First Byte

// Manual performance measurement
const measure = (name, fn) => {
  performance.mark(`${name}-start`);
  fn();
  performance.mark(`${name}-end`);
  performance.measure(name, `${name}-start`, `${name}-end`);
  const measure = performance.getEntriesByName(name)[0];
  console.log(`${name}: ${measure.duration.toFixed(2)}ms`);
};

measure('data-fetch', () => {
  // Your code here
});
```

### Testing Strategy

**Standard:** Unit + Integration testing, min 60% coverage.

```jsx
// Example test structure
import { render, screen, fireEvent } from '@testing-library/react';
import Button from './Button';

describe('Button Component', () => {
  test('renders with label', () => {
    render(<Button>Click me</Button>);
    expect(screen.getByText('Click me')).toBeInTheDocument();
  });

  test('calls onClick handler', () => {
    const handleClick = vi.fn();
    render(<Button onClick={handleClick}>Click</Button>);
    fireEvent.click(screen.getByText('Click'));
    expect(handleClick).toHaveBeenCalled();
  });

  test('disables button when disabled prop is true', () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
```

---

## Frontend AI Implementation Checklist

When building any React mobile app, follow this checklist:

### Pre-Development
- [ ] Define 3-5 core user tasks
- [ ] Choose target platforms (iOS, Android, or both)
- [ ] Create wireframes for key screens
- [ ] Set design goals & KPIs
- [ ] Review platform guidelines (HIG for iOS, Material 3 for Android)

### Component Architecture
- [ ] Create component folder structure
- [ ] Build reusable design system components
- [ ] Set up theme provider (light/dark mode)
- [ ] Implement color, typography, spacing systems
- [ ] Create custom hooks for common logic

### UI/UX Implementation
- [ ] Apply one-hand-centered design (thumb zones)
- [ ] Implement gesture UI (swipe, tap, long-press)
- [ ] Create notification strategy (toast, alerts, modals)
- [ ] Design onboarding flow (max 3 screens)
- [ ] Add empty states with clear CTAs
- [ ] Ensure consistent navigation (tab bar or drawer)

### Performance
- [ ] Optimize all images (WebP + fallback)
- [ ] Implement code splitting & lazy loading
- [ ] Set up virtual scrolling for long lists
- [ ] Enable caching strategy
- [ ] Measure Core Web Vitals
- [ ] Keep main bundle <100KB gzipped

### Accessibility
- [ ] Test keyboard navigation
- [ ] Verify color contrast (4.5:1 minimum)
- [ ] Add meaningful alt text to images
- [ ] Implement ARIA labels where needed
- [ ] Respect `prefers-reduced-motion`
- [ ] Test with screen readers

### Responsive Design
- [ ] Mobile-first CSS approach
- [ ] Touch targets min 44x44pt / 48x48dp
- [ ] Safe area insets for notches
- [ ] Responsive breakpoints (mobile, tablet, desktop)
- [ ] Test on multiple device sizes

### Code Quality
- [ ] TypeScript for type safety
- [ ] ESLint + Prettier configuration
- [ ] Unit & integration tests (min 60% coverage)
- [ ] Component documentation
- [ ] Error handling & logging

### Deployment
- [ ] Production optimizations (minify, compress)
- [ ] Environment variables configured
- [ ] Error tracking setup
- [ ] Analytics/monitoring setup
- [ ] Test on real devices before launch

---

## References & Further Reading

**Platform Guidelines:**
- [Apple Human Interface Guidelines (2025)](https://developer.apple.com/design/human-interface-guidelines/)
- [Google Material Design 3](https://m3.material.io/)

**React Documentation:**
- [React Official Docs](https://react.dev/)
- [React Native Docs](https://reactnative.dev/)

**Performance:**
- [Web Vitals Guide](https://web.dev/vitals/)
- [Lighthouse Performance Auditing](https://developers.google.com/web/tools/lighthouse)

**Accessibility:**
- [WCAG 2.1 Guidelines](https://www.w3.org/WAI/WCAG21/quickref/)
- [WebAIM Contrast Checker](https://webaim.org/resources/contrastchecker/)

**Design Systems:**
- [Shadcn/ui Components](https://ui.shadcn.com/)
- [Radix UI Primitives](https://www.radix-ui.com/)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | Sept 2026 | Initial comprehensive guide based on 2025-2026 research |

---

**Document Owner:** Frontend AI Assistant  
**Last Reviewed:** September 2026  
**Review Frequency:** Quarterly (Design trends, React updates)

---

