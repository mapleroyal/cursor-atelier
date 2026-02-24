import { createMemoryRouter } from "react-router";
import { HomeRoute } from "@/app/routes/home";

export const router = createMemoryRouter([
  {
    path: "/",
    element: <HomeRoute />,
  },
]);
