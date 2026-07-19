import Header from "@/components/landing/Header";
import PageBackground from "@/components/landing/PageBackground";
import Hero from "@/components/landing/Hero";
import ProblemSection from "@/components/landing/ProblemSection";
import BeforeAfterSection from "@/components/landing/BeforeAfterSection";
import HowItWorksSection from "@/components/landing/HowItWorksSection";
import AISection from "@/components/landing/AISection";
import AutomationSection from "@/components/landing/AutomationSection";
import DashboardPreviewSection from "@/components/landing/DashboardPreviewSection";
import InteractiveDemoSection from "@/components/landing/InteractiveDemoSection";
import TrustSection from "@/components/landing/TrustSection";
import TestimonialsSection from "@/components/landing/TestimonialsSection";
import FAQSection from "@/components/landing/FAQSection";
import FinalCTASection from "@/components/landing/FinalCTASection";
import ContactSection from "@/components/landing/ContactSection";
import Footer from "@/components/landing/Footer";
import DemoRequestModal from "@/components/landing/DemoRequestModal";

export default function Home() {
  return (
    <div className="relative flex flex-1 flex-col">
      <PageBackground />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-1/2 focus:z-[100] focus:-translate-x-1/2 focus:rounded-full focus:bg-white focus:px-5 focus:py-2.5 focus:text-sm focus:font-semibold focus:text-text-primary focus:shadow-card-lg"
      >
        דלגו לתוכן הראשי
      </a>
      <Header />
      <main id="main-content" className="flex-1">
        <Hero />
        <ProblemSection />
        <BeforeAfterSection />
        <HowItWorksSection />
        <AISection />
        <AutomationSection />
        <DashboardPreviewSection />
        <InteractiveDemoSection />
        <TrustSection />
        <TestimonialsSection />
        <FAQSection />
        <FinalCTASection />
        <ContactSection />
      </main>
      <Footer />
      <DemoRequestModal />
    </div>
  );
}
